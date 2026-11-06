import { authorizeIdentityOperation } from './identity-authorization.js';
import { requireSupportAssurance, supportAssurance } from './support-assurance.js';
import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../shared/http/async-handler.js';
import { HttpError } from '../../shared/http/errors.js';
import type { Logger } from '../../shared/logging/logger.js';
import type { Principal } from '../auth/oidc-authenticator.js';
import type { AppConfig } from '../../config/app-config.js';
import type { IdentityAdminClient } from './types.js';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const UserIdSchema = z.string().uuid();
const QueryBoolean = z
  .enum(['true', 'false'])
  .transform((value) => value === 'true')
  .optional();
const ListSchema = z.object({
  role: z.string().trim().min(1).max(150).optional(),
  enabled: QueryBoolean,
  emailVerified: QueryBoolean,
  search: z.string().trim().min(1).max(120).optional(),
  first: z.coerce.number().int().min(0).max(10_000).default(0),
  max: z.coerce.number().int().min(1).max(100).default(25),
});
const UserSummarySchema = ListSchema.pick({
  role: true,
  enabled: true,
  emailVerified: true,
  search: true,
});
const CreateUserSchema = z.object({
  username: z.string().trim().min(3).max(255),
  email: z.string().email().max(255),
  firstName: z.string().trim().min(1).max(255).optional(),
  lastName: z.string().trim().min(1).max(255).optional(),
  sendVerifyEmail: z.boolean().default(false),
});
const UpdateUserSchema = z
  .object({
    firstName: z.string().trim().min(1).max(255).optional(),
    lastName: z.string().trim().min(1).max(255).optional(),
    enabled: z.boolean().optional(),
    email: z.string().email().max(255).optional(),
  })
  .strict()
  .refine((update) => Object.keys(update).length > 0, 'At least one field is required.');
const RolesSchema = z.object({ roles: z.array(z.string().min(1).max(150)).max(100) });
const BatchRolesSchema = z
  .object({
    userIds: z
      .array(UserIdSchema)
      .min(1)
      .max(100)
      .refine((userIds) => new Set(userIds).size === userIds.length),
    addRoles: z.array(z.string().min(1).max(150)).max(100).default([]),
    removeRoles: z.array(z.string().min(1).max(150)).max(100).default([]),
  })
  .strict()
  .refine(
    ({ addRoles, removeRoles }) =>
      (addRoles.length > 0 || removeRoles.length > 0) &&
      new Set(addRoles).size === addRoles.length &&
      new Set(removeRoles).size === removeRoles.length &&
      !addRoles.some((role) => removeRoles.includes(role)),
  );

const ActiveRegistrySchema = z.object({
  environment: z.enum(['local', 'staging', 'production']),
  generation: z.number().int().positive(),
  revision: z.string().regex(/^[a-f0-9]{64}$/),
  permissions: z.array(z.object({ name: z.string() })).max(2000),
  roles: z
    .array(z.object({ name: z.string(), permissions: z.array(z.string()).max(2000) }))
    .max(250),
});
type ActiveRegistry = z.infer<typeof ActiveRegistrySchema>;

const loadActiveRegistry = (config: AppConfig | undefined): ActiveRegistry => {
  try {
    if (!config) throw new Error('Missing catalogue configuration.');
    const file = join(dirname(config.APP_AUTHORIZATION_CATALOGUE_PATH), 'active-registry.json');
    const registry = ActiveRegistrySchema.parse(JSON.parse(readFileSync(file, 'utf8')));
    if (registry.environment !== config.APP_IDENTITY_ENVIRONMENT)
      throw new Error('Catalogue environment mismatch.');
    return registry;
  } catch {
    throw new HttpError(
      503,
      'catalogue_unavailable',
      'The applied authorization catalogue is unavailable.',
    );
  }
};

const rolePermissions = (registry: ActiveRegistry, requested: readonly string[]): Set<string> => {
  const permissions = new Set(registry.permissions.map((permission) => permission.name));
  const roles = new Map(registry.roles.map((role) => [role.name, role.permissions]));
  const granted = new Set<string>();
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (name: string): void => {
    if (permissions.has(name)) {
      granted.add(name);
      return;
    }
    const children = roles.get(name);
    if (!children)
      throw new HttpError(400, 'invalid_role', 'Select roles from the applied catalogue.');
    if (visiting.has(name))
      throw new HttpError(503, 'invalid_catalogue', 'The applied catalogue contains a role cycle.');
    if (visited.has(name)) return;
    visiting.add(name);
    children.forEach(visit);
    visiting.delete(name);
    visited.add(name);
  };
  requested.forEach((name) => {
    if (!roles.has(name))
      throw new HttpError(400, 'invalid_role', 'Select roles from the applied catalogue.');
    visit(name);
  });
  return granted;
};

export const assertRoleDelegation = (
  principal: Principal,
  requested: readonly string[],
  registry: ActiveRegistry,
): void => {
  const signed = new Set(principal.roles);
  const current = new Set(principal.effectiveRoleNames ?? []);
  const authority = [`admin-web:${registry.environment}:access`, 'identity:users:update:roles'];
  if (authority.some((permission) => !signed.has(permission) || !current.has(permission)))
    throw new HttpError(
      403,
      'role_delegation_forbidden',
      'Current role assignment permission is required.',
    );
  const permissions = rolePermissions(registry, requested);
  // The current protected administrator role includes every applied catalogue
  // permission. Validate the entire role graph before using that authority;
  // service entry and role-assignment permission still need signed/live proof.
  if (current.has('administrador')) return;
  if (requested.includes('administrador'))
    throw new HttpError(
      403,
      'protected_role',
      'Only a current identity administrator can manage the protected administrator role.',
    );
  for (const permission of permissions)
    if (!signed.has(permission) || !current.has(permission))
      throw new HttpError(
        403,
        'role_delegation_forbidden',
        'You cannot delegate permissions outside your signed and current access.',
      );
};

export const createIdentityRouter = (
  client: IdentityAdminClient,
  logger: Logger,
  config?: AppConfig,
): Router => {
  const router = Router();
  router.use(authorizeIdentityOperation);
  const currentPrincipal = async (principal: Principal): Promise<Principal> => {
    const user = await client.getUser(principal.subject);
    if (!user.enabled) throw new HttpError(403, 'account_disabled', 'Your account is disabled.');
    return {
      ...principal,
      effectiveRoleNames:
        principal.effectiveRoleNames ??
        (
          await (client.getUserRealmEffectiveRoles?.(principal.subject) ??
            client.getUserRealmRoles(principal.subject))
        ).map((role) => role.name),
    };
  };
  const protectAdministrator = async (userId: string, principal: Principal): Promise<void> => {
    const targetRoles = await (client.getUserRealmEffectiveRoles?.(userId) ??
      client.getUserRealmRoles(userId));
    if (targetRoles.some((role) => role.name === 'administrador')) {
      const current = await currentPrincipal(principal);
      if (!current.effectiveRoleNames?.includes('administrador'))
        throw new HttpError(
          403,
          'protected_account',
          'Only a current identity administrator can manage a protected administrator account.',
        );
    }
  };
  const verificationOptions = () => ({
    lifespan: config?.APP_ACTIVATION_LIFESPAN_SECONDS ?? 3600,
    ...(config?.APP_ACCOUNT_PUBLIC_URL
      ? { clientId: config.APP_ACCOUNT_CLIENT_ID, redirectUri: config.APP_ACCOUNT_PUBLIC_URL }
      : {}),
  });
  router.get(
    '/support-assurance',
    asyncHandler(async (_request, response) => {
      response.json(await supportAssurance(response.locals.principal as Principal, client));
    }),
  );
  router.get(
    '/users/:userId/recovery',
    asyncHandler(async (request, response) => {
      const userId = UserIdSchema.parse(request.params.userId);
      if (!client.recoveryStatus)
        throw new HttpError(503, 'recovery_unavailable', 'Account recovery is unavailable.');
      response
        .set('Cache-Control', 'no-store')
        .json(await client.recoveryStatus(userId, request.get('authorization')?.slice(7) ?? ''));
    }),
  );
  router.post(
    '/users/:userId/recovery/prepare',
    asyncHandler(async (request, response) => {
      const userId = UserIdSchema.parse(request.params.userId);
      if (!client.prepareRecovery)
        throw new HttpError(503, 'recovery_unavailable', 'Account recovery is unavailable.');
      response
        .set('Cache-Control', 'no-store')
        .json(await client.prepareRecovery(userId, request.get('authorization')?.slice(7) ?? ''));
    }),
  );
  router.post(
    '/users/:userId/recovery',
    asyncHandler(async (request, response) => {
      const userId = UserIdSchema.parse(request.params.userId);
      const body = z
        .object({
          draftId: z.string().uuid().optional(),
          reason: z.string().trim().min(10).max(500),
          // Older clients may send a reference; the server generates and owns it.
          caseReference: z.string().max(150).optional(),
          identityVerified: z.literal(true),
        })
        .strict()
        .parse(request.body);
      const principal = response.locals.principal as Principal;
      if (principal.stepUpScope && principal.stepUpScope !== `user:${userId}:credentials`)
        throw new HttpError(
          403,
          'verification_scope_mismatch',
          'This verification is for another account.',
        );
      await requireSupportAssurance(principal, client);
      if (!client.createRecovery)
        throw new HttpError(503, 'recovery_unavailable', 'Account recovery is unavailable.');
      const result = await client.createRecovery(
        userId,
        request.get('authorization')?.slice(7) ?? '',
        {
          reason: body.reason,
          identityVerified: body.identityVerified,
          ...(body.draftId ? { draftId: body.draftId } : {}),
        },
      );
      audit(logger, response, 'user.recovery_created', userId, {
        recovery_id: result.id,
        case_reference: result.caseReference,
      });
      response.set('Cache-Control', 'no-store').status(201).json(result);
    }),
  );
  router.delete(
    '/users/:userId/recovery/:recoveryId',
    asyncHandler(async (request, response) => {
      const userId = UserIdSchema.parse(request.params.userId);
      const recoveryId = UserIdSchema.parse(request.params.recoveryId);
      const principal = response.locals.principal as Principal;
      if (principal.stepUpScope && principal.stepUpScope !== `user:${userId}:credentials`)
        throw new HttpError(
          403,
          'verification_scope_mismatch',
          'This verification is for another account.',
        );
      await requireSupportAssurance(principal, client);
      if (!client.revokeRecovery)
        throw new HttpError(503, 'recovery_unavailable', 'Account recovery is unavailable.');
      await client.revokeRecovery(userId, recoveryId, request.get('authorization')?.slice(7) ?? '');
      audit(logger, response, 'user.recovery_revoked', userId, { recovery_id: recoveryId });
      response.status(204).end();
    }),
  );
  router.get(
    '/security-events',
    asyncHandler(async (request, response) => {
      const filters = z
        .object({
          user: z.string().uuid().optional(),
          search: z.string().trim().min(1).max(150).optional(),
          client: z.string().trim().min(1).max(150).optional(),
          type: z
            .string()
            .regex(/^[A-Z_]+$/)
            .max(80)
            .optional(),
          dateFrom: z.string().date().optional(),
          dateTo: z.string().date().optional(),
          first: z.coerce.number().int().min(0).max(10000).default(0),
          max: z.coerce.number().int().min(1).max(100).default(50),
        })
        .strict()
        .parse(request.query);
      if (!client.listSecurityEvents)
        throw new HttpError(503, 'events_unavailable', 'Security events are unavailable.');
      response.json(await client.listSecurityEvents(filters));
    }),
  );

  router.get(
    '/users',
    asyncHandler(async (request, response) => {
      const query = ListSchema.parse(request.query);
      const users = await client.listUsers(query.search, query.first, query.max, {
        role: query.role,
        enabled: query.enabled,
        emailVerified: query.emailVerified,
      });
      response.json({ users, page: { first: query.first, max: query.max } });
    }),
  );

  router.get(
    '/users/summary',
    asyncHandler(async (request, response) => {
      if (!client.summarizeUsers)
        throw new HttpError(503, 'user_summary_unavailable', 'User totals are unavailable.');
      const query = UserSummarySchema.parse(request.query);
      response.json(
        await client.summarizeUsers(query.search, {
          role: query.role,
          enabled: query.enabled,
          emailVerified: query.emailVerified,
        }),
      );
    }),
  );

  router.get(
    '/users/:userId',
    asyncHandler(async (request, response) => {
      const userId = UserIdSchema.parse(request.params.userId);
      const [user, roles] = await Promise.all([
        client.getUser(userId),
        client.getUserRealmRoles(userId),
      ]);
      response.json({
        user,
        roles,
        sessions: await client.listSessions(userId),
      });
    }),
  );

  router.get(
    '/users/:userId/credentials',
    asyncHandler(async (request, response) => {
      const userId = UserIdSchema.parse(request.params.userId);
      if (!client.listCredentials)
        throw new HttpError(
          503,
          'credentials_unavailable',
          'Authentication methods are unavailable.',
        );
      const credentials = (await client.listCredentials(userId))
        .filter((credential) => ['webauthn-passwordless', 'otp'].includes(credential.type))
        .map(({ id, type, userLabel, createdDate }) => ({ id, type, userLabel, createdDate }));
      const effectiveRoles = await (client.getUserRealmEffectiveRoles?.(userId) ??
        client.getUserRealmRoles(userId));
      response.json({
        credentials,
        requiresPasskey: effectiveRoles.some(
          (role) =>
            role.name === 'administrador' ||
            /^admin-web:(?:local|staging|production):access$/.test(role.name),
        ),
      });
    }),
  );
  router.delete(
    '/users/:userId/credentials/:credentialId',
    asyncHandler(async (request, response) => {
      const userId = UserIdSchema.parse(request.params.userId);
      const credentialId = z.string().min(1).max(255).parse(request.params.credentialId);
      const { reason } = z
        .object({ reason: z.string().trim().min(10).max(500), confirmed: z.literal(true) })
        .strict()
        .parse(request.body);
      if (!client.deleteCredential)
        throw new HttpError(
          503,
          'credentials_unavailable',
          'Authentication methods are unavailable.',
        );
      const principal = response.locals.principal as Principal;
      if (principal.stepUpScope && principal.stepUpScope !== `user:${userId}:credentials`)
        throw new HttpError(
          403,
          'verification_scope_mismatch',
          'This verification is for another operation.',
        );
      await requireSupportAssurance(principal, client);
      await client.deleteCredential(
        userId,
        credentialId,
        request.get('authorization')?.slice(7) ?? '',
        reason,
      );
      audit(logger, response, 'user.credential_removed', userId, {
        credential_id: credentialId,
        reason,
      });
      response.status(204).end();
    }),
  );
  router.delete(
    '/users/:userId/sessions/:sessionId',
    asyncHandler(async (request, response) => {
      const userId = UserIdSchema.parse(request.params.userId);
      const sessionId = z.string().min(1).max(255).parse(request.params.sessionId);
      await client.logoutSession(userId, sessionId);
      audit(logger, response, 'user.session_revoked', userId, { session_id: sessionId });
      response.status(204).end();
    }),
  );

  router.post(
    '/users',
    asyncHandler(async (request, response) => {
      const input = CreateUserSchema.parse(request.body);
      const { sendVerifyEmail, ...user } = input;
      if (rolePermissions(loadActiveRegistry(config), ['member']).size > 0)
        throw new HttpError(
          409,
          'privileged_member_role',
          'The default member role must not grant service access.',
        );
      const userId = await client.createUser(user);
      let setupPending = false;
      try {
        await client.replaceManagedRealmRoles(userId, ['member']);
        if (sendVerifyEmail)
          await client.executeActionsEmail(userId, ['VERIFY_EMAIL'], verificationOptions());
      } catch {
        setupPending = true;
      }
      audit(logger, response, 'user.created', userId, {
        verification_email_sent: sendVerifyEmail && !setupPending,
        setup_pending: setupPending,
      });
      response.status(201).json({ id: userId, setupPending });
    }),
  );

  router.patch(
    '/users/:userId',
    asyncHandler(async (request, response) => {
      const userId = UserIdSchema.parse(request.params.userId);
      const input = UpdateUserSchema.parse(request.body);
      const principal = response.locals.principal as Principal;
      if (userId === principal.subject && input.enabled === false)
        throw new HttpError(409, 'self_disable_blocked', 'You cannot disable your own account.');
      if (input.enabled === false) {
        await protectAdministrator(userId, principal);
        if (
          principal.stepUpScope &&
          principal.stepUpScope !== `user:${userId}:credentials` &&
          principal.stepUpScope !== `user:${userId}:deactivate`
        )
          throw new HttpError(
            403,
            'verification_scope_mismatch',
            'This verification is for another operation.',
          );
        await requireSupportAssurance(principal, client);
      }
      await client.updateUser(userId, input);
      if (input.enabled === false) await client.logoutUser(userId);
      audit(logger, response, 'user.updated', userId, { fields: Object.keys(input) });
      response.status(204).end();
    }),
  );

  router.post(
    '/users/:userId/logout',
    asyncHandler(async (request, response) => {
      const userId = UserIdSchema.parse(request.params.userId);
      await client.logoutUser(userId);
      audit(logger, response, 'user.sessions_revoked', userId);
      response.status(204).end();
    }),
  );

  router.get(
    '/roles',
    asyncHandler(async (_request, response) => {
      response.json({ roles: await client.listRealmRoles() });
    }),
  );

  router.put(
    '/users/:userId/roles',
    asyncHandler(async (request, response) => {
      const userId = UserIdSchema.parse(request.params.userId);
      const { roles } = RolesSchema.parse(request.body);
      const principal = response.locals.principal as Principal;
      if (principal.subject === userId && !roles.includes('administrador')) {
        throw new HttpError(
          409,
          'self_demotion_blocked',
          'You cannot remove your own administrator role.',
        );
      }
      const current = await currentPrincipal(principal);
      const assigned = await client.getUserRealmRoles(userId);
      const removedAdministrator =
        assigned.some((role) => role.name === 'administrador') && !roles.includes('administrador');
      assertRoleDelegation(
        current,
        removedAdministrator ? [...roles, 'administrador'] : roles,
        loadActiveRegistry(config),
      );
      await client.replaceManagedRealmRoles(userId, roles);
      audit(logger, response, 'user.roles_replaced', userId, { roles });
      response.status(204).end();
    }),
  );

  router.put(
    '/users/roles/batch',
    asyncHandler(async (request, response) => {
      const { userIds, addRoles, removeRoles } = BatchRolesSchema.parse(request.body);
      const principal = response.locals.principal as Principal;
      if (userIds.includes(principal.subject) && removeRoles.includes('administrador')) {
        throw new HttpError(
          409,
          'self_demotion_blocked',
          'You cannot remove your own administrator role.',
        );
      }
      const current = await currentPrincipal(principal);
      assertRoleDelegation(current, [...addRoles, ...removeRoles], loadActiveRegistry(config));

      const managedRoles = await client.listRealmRoles();
      const managedNames = new Set(managedRoles.map((role) => role.name));
      if ([...addRoles, ...removeRoles].some((role) => !managedNames.has(role))) {
        throw new HttpError(400, 'invalid_role', 'Select roles from the authorized catalogue.');
      }

      const updatedUserIds: string[] = [];
      const failedUserIds: string[] = [];
      for (const userId of userIds) {
        try {
          const assigned = await client.getUserRealmRoles(userId);
          const targetRoles = new Set(
            assigned.map((role) => role.name).filter((name) => managedNames.has(name)),
          );
          addRoles.forEach((role) => targetRoles.add(role));
          removeRoles.forEach((role) => targetRoles.delete(role));
          await client.replaceManagedRealmRoles(userId, [...targetRoles]);
          updatedUserIds.push(userId);
          audit(logger, response, 'user.roles_batch_updated', userId, {
            added_roles: addRoles,
            removed_roles: removeRoles,
          });
        } catch {
          failedUserIds.push(userId);
          audit(logger, response, 'user.roles_batch_update_failed', userId, {
            added_roles: addRoles,
            removed_roles: removeRoles,
          });
        }
      }
      response.json({ updatedUserIds, failedUserIds });
    }),
  );

  router.delete(
    '/users/:userId',
    asyncHandler(async (request, response) => {
      const userId = UserIdSchema.parse(request.params.userId);
      if (userId === (response.locals.principal as Principal).subject)
        throw new HttpError(
          409,
          'self_delete_blocked',
          'You cannot delete your own administrator account.',
        );
      const principal = response.locals.principal as Principal;
      await protectAdministrator(userId, principal);
      if (principal.stepUpScope && principal.stepUpScope !== `user:${userId}:credentials`)
        throw new HttpError(
          403,
          'verification_scope_mismatch',
          'This verification is for another operation.',
        );
      await requireSupportAssurance(principal, client);
      await client.deleteUser(userId);
      audit(logger, response, 'user.deleted', userId);
      response.status(204).end();
    }),
  );

  router.post(
    '/users/:userId/send-verification',
    asyncHandler(async (request, response) => {
      const userId = UserIdSchema.parse(request.params.userId);
      if (!client.reserveVerification)
        throw new HttpError(503, 'verification_unavailable', 'Email verification is unavailable.');
      await client.reserveVerification(userId, request.get('authorization')?.slice(7) ?? '');
      await client.executeActionsEmail(userId, ['VERIFY_EMAIL'], verificationOptions());
      audit(logger, response, 'user.verification_requested', userId);
      response.status(204).end();
    }),
  );

  router.post(
    '/users/:userId/send-activation',
    asyncHandler(async (request, response) => {
      const userId = UserIdSchema.parse(request.params.userId);
      if (!client.reserveVerification)
        throw new HttpError(503, 'verification_unavailable', 'Email verification is unavailable.');
      await client.reserveVerification(userId, request.get('authorization')?.slice(7) ?? '');
      await client.executeActionsEmail(userId, ['VERIFY_EMAIL'], verificationOptions());
      audit(logger, response, 'user.activation_requested', userId);
      response.status(204).end();
    }),
  );

  return router;
};

const audit = (
  logger: Logger,
  response: { locals: Record<string, unknown>; getHeader(name: string): unknown },
  action: string,
  targetUserId: string,
  data: Record<string, unknown> = {},
): void => {
  const principal = response.locals.principal as Principal;
  logger.info('identity administration action', {
    audit: true,
    action,
    actor_id: principal.subject,
    actor_username: principal.username,
    target_user_id: targetUserId,
    request_id: response.getHeader('x-request-id'),
    ...data,
  });
};
