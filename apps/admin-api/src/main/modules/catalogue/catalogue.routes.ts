import { hasIdentityOperationPolicy } from '../../shared/identity-policies.js';
import { HttpError } from '../../shared/http/errors.js';
import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../shared/http/async-handler.js';
import type { Logger } from '../../shared/logging/logger.js';
import type { Principal } from '../auth/oidc-authenticator.js';
import {
  CatalogueSchema,
  defaultRoleOptions,
  isDefaultApplicationAccess,
  validateCatalogue,
  type Catalogue,
} from './catalogue-model.js';
import type { CatalogueService, CatalogueAuthorization } from './catalogue-service.js';
import { Environment } from './catalogue-service.js';
const Sha = z.string().regex(/^[a-f0-9]{64}$/);
const Targets = z
  .array(Environment)
  .min(1)
  .max(1)
  .refine((items) => new Set(items).size === items.length);
const Reason = z.string().trim().min(8).max(300);

const effectiveCatalogueGrants = (catalogue: Catalogue) => {
  const permissions = new Set(catalogue.permissions.map((permission) => permission.name));
  const roles = new Map(catalogue.roles.map((role) => [role.name, role.permissions]));
  const expanded = new Map<string, Set<string>>();
  const visiting = new Set<string>();
  const expand = (name: string): Set<string> => {
    if (permissions.has(name)) return new Set([name]);
    const cached = expanded.get(name);
    if (cached) return cached;
    const children = roles.get(name);
    if (!children)
      throw new HttpError(
        422,
        'missing_reference',
        `Role ${name} does not exist in the catalogue.`,
      );
    if (visiting.has(name))
      throw new HttpError(422, 'role_cycle', 'The catalogue contains a role composition cycle.');
    visiting.add(name);
    const grants = new Set<string>();
    for (const child of children) for (const permission of expand(child)) grants.add(permission);
    visiting.delete(name);
    expanded.set(name, grants);
    return grants;
  };
  for (const role of catalogue.roles) expand(role.name);
  const groups = new Map(
    catalogue.groups.map((group) => {
      const grants = new Set<string>();
      for (const role of group.roles) for (const permission of expand(role)) grants.add(permission);
      return [group.name, grants] as const;
    }),
  );
  return { roles: expanded, groups };
};

export const assertCatalogueDelegation = (
  principal: Pick<Principal, 'roles' | 'effectiveRoleNames'>,
  next: Catalogue,
  previous: Catalogue,
): void => {
  const signed = new Set(principal.roles);
  const current = new Set(principal.effectiveRoleNames ?? []);
  if (!signed.has('identity:roles:manage') || !current.has('identity:roles:manage'))
    throw new HttpError(
      403,
      'catalogue_delegation_forbidden',
      'Current catalogue management permission is required.',
    );
  const before = effectiveCatalogueGrants(previous);
  const after = effectiveCatalogueGrants(next);
  const oldAtoms = new Set(previous.permissions.map((permission) => permission.name));
  const newAtoms = new Set(
    next.permissions
      .filter((permission) => !oldAtoms.has(permission.name))
      .map((permission) => permission.name),
  );
  const protectedActor = current.has('administrador');
  const previousDefault = previous.defaultRole ?? 'member';
  const nextDefault = next.defaultRole ?? previousDefault;
  const previousDefaultGrants = before.roles.get(previousDefault) ?? new Set<string>();
  const nextDefaultGrants = after.roles.get(nextDefault) ?? new Set<string>();
  if (
    !protectedActor &&
    (previousDefault !== nextDefault ||
      previousDefaultGrants.size !== nextDefaultGrants.size ||
      [...nextDefaultGrants].some((permission) => !previousDefaultGrants.has(permission)))
  )
    throw new HttpError(
      403,
      'protected_configuration',
      'Only a current identity administrator can change the registration default role or its access.',
    );
  if (
    (newAtoms.size > 0 ||
      previous.permissions.some(
        (permission) => !next.permissions.some((item) => item.name === permission.name),
      ) ||
      JSON.stringify(next.accessRules ?? []) !== JSON.stringify(previous.accessRules ?? [])) &&
    !protectedActor
  )
    throw new HttpError(
      403,
      'protected_configuration',
      'Only a current identity administrator can declare permissions or change application access rules.',
    );
  for (const kind of ['roles', 'groups'] as const)
    for (const [name, grants] of after[kind]) {
      const existing = before[kind].get(name) ?? new Set<string>();
      // The live protected role includes every validated catalogue permission,
      // including atoms declared after this token was issued. Catalogue
      // management itself still requires both signed and live authority above.
      for (const permission of grants)
        if (
          !protectedActor &&
          !existing.has(permission) &&
          (!signed.has(permission) || !current.has(permission))
        )
          throw new HttpError(
            403,
            'catalogue_delegation_forbidden',
            'You cannot grant new role or group permissions outside your signed and current access.',
          );
    }
  if (!current.has('administrador')) {
    const beforeProtected = new Set(
      previous.groups
        .filter((group) => group.roles.includes('administrador'))
        .map((group) => group.name),
    );
    const afterProtected = new Set(
      next.groups
        .filter((group) => group.roles.includes('administrador'))
        .map((group) => group.name),
    );
    if (
      [...beforeProtected].some((name) => !afterProtected.has(name)) ||
      [...afterProtected].some((name) => !beforeProtected.has(name))
    )
      throw new HttpError(
        403,
        'protected_role',
        'Only a current identity administrator can change protected administrator group membership.',
      );
  }
};

export function createCatalogueRouter(service: CatalogueService, logger: Logger): Router {
  const router = Router();
  router.use((request, response, next) => {
    const roles = (response.locals.principal as Principal).roles;
    const permission = request.method === 'GET' ? 'identity:roles:view' : 'identity:roles:manage';
    if (
      !hasIdentityOperationPolicy(
        roles,
        permission,
        String(response.locals.identityEnvironment ?? service.environment),
      )
    ) {
      next(new HttpError(403, 'insufficient_permission', 'Catalogue permission required.'));
      return;
    }
    next();
  });
  router.use((request, _response, next) => {
    const body = request.body as
      | { sourceEnvironment?: string; environment?: string; environments?: string[] }
      | undefined;
    const requested = request.query.environment ?? body?.sourceEnvironment ?? body?.environment;
    const targets = (request.body as { environments?: string[] } | undefined)?.environments;
    if (
      (requested && requested !== service.environment) ||
      (Array.isArray(targets) && targets.some((env) => env !== service.environment))
    ) {
      next(
        new HttpError(
          403,
          'environment_not_allowed',
          'This console only manages its configured environment.',
        ),
      );
      return;
    }
    next();
  });
  const actor = (locals: Record<string, unknown>) => (locals.principal as Principal).subject;
  const authorize =
    (locals: Record<string, unknown>, bearer: string): CatalogueAuthorization =>
    async (next, previous) => {
      assertCatalogueDelegation(locals.principal as Principal, next, previous);
      await service.assertPermissionDeletion(next, previous, bearer);
    };
  router.get(
    '/',
    asyncHandler(async (req, res) => {
      const environment =
        req.query.environment === undefined ? undefined : Environment.parse(req.query.environment);
      const current = await service.current(environment);
      const protectedActor =
        (res.locals.principal as Principal).effectiveRoleNames?.includes('administrador') === true;
      res.json({
        ...current,
        capabilities: { managePermissions: protectedActor, manageAccessRules: protectedActor },
        defaultRoleAccessPermissions: protectedActor
          ? current.catalogue.permissions.map(({ name }) => name).filter(isDefaultApplicationAccess)
          : [],
        defaultRoleOptions: protectedActor ? defaultRoleOptions(current.catalogue) : [],
      });
    }),
  );
  router.get(
    '/snapshots/:environment/:revision',
    asyncHandler(async (req, res) => {
      const environment = Environment.parse(req.params.environment);
      if (environment !== service.environment)
        throw new HttpError(
          403,
          'environment_not_allowed',
          'This console only manages its configured environment.',
        );
      res.json(
        await service.snapshot(
          environment,
          z
            .string()
            .regex(/^[a-f0-9]{64}$/)
            .parse(req.params.revision),
        ),
      );
    }),
  );
  router.post(
    '/validate',
    asyncHandler(async (req, res) => {
      const input = z
        .object({ catalogue: CatalogueSchema, environment: Environment.optional() })
        .strict()
        .parse(req.body);
      const previous = await service.current(input.environment);
      const next = validateCatalogue(input.catalogue, previous.catalogue);
      await authorize(res.locals, req.get('authorization')?.slice(7) ?? '')(
        next,
        previous.catalogue,
        service.environment,
      );
      res.json({ valid: true });
    }),
  );
  router.post(
    '/revisions',
    asyncHandler(async (req, res) => {
      const input = z
        .object({
          baseSha: Sha,
          catalogue: CatalogueSchema,
          reason: Reason,
          environments: Targets,
          sourceEnvironment: Environment.optional(),
        })
        .strict()
        .parse(req.body);
      const revision = await service.publish(
        input.baseSha,
        input.catalogue,
        input.reason,
        actor(res.locals),
        input.environments,
        input.sourceEnvironment,
        authorize(res.locals, req.get('authorization')?.slice(7) ?? ''),
      );
      logger.info('catalogue revision published', {
        audit: true,
        actor_id: actor(res.locals),
        revision: revision.id,
        environments: input.environments,
      });
      res.status(201).json({ revision });
    }),
  );
  router.get(
    '/revisions',
    asyncHandler(async (_req, res) => {
      res.json({ revisions: await service.revisions() });
    }),
  );
  router.post(
    '/rollbacks',
    asyncHandler(async (req, res) => {
      const input = z
        .object({
          baseSha: Sha,
          operationId: z.string().regex(/^[a-f0-9]{64}$/),
          environments: Targets,
          reason: Reason,
        })
        .strict()
        .parse(req.body);
      const revision = await service.rollback(
        input.baseSha,
        input.operationId,
        input.environments,
        input.reason,
        actor(res.locals),
        authorize(res.locals, req.get('authorization')?.slice(7) ?? ''),
      );
      logger.info('catalogue roles rollback published', {
        audit: true,
        actor_id: actor(res.locals),
        revision: revision.id,
        restored_operation: input.operationId,
        environments: input.environments,
      });
      res.status(201).json({ revision });
    }),
  );
  router.get(
    '/environments',
    asyncHandler(async (_req, res) => {
      const environments = await Promise.all(
        [service.environment].map(async (env) => {
          try {
            return await service.status(Environment.parse(env));
          } catch {
            return {
              environment: env,
              state: 'unknown',
              detail: 'Unable to verify this environment.',
              revision: null,
              desiredRevision: null,
              observedRevision: null,
              enabled: false,
            };
          }
        }),
      );
      res.json({ environments });
    }),
  );
  return router;
}
