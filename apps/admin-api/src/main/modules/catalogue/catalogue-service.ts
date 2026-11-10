import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ProviderCatalogueClient } from '@scoretech/identity-internal';
import type { AppConfig } from '../../config/app-config.js';
import { HttpError } from '../../shared/http/errors.js';
import { CatalogueSchema, validateCatalogue, type Catalogue } from './catalogue-model.js';
export const Environment = z.enum(['local', 'staging', 'production']);
export type EnvironmentName = z.infer<typeof Environment>;
export type CatalogueAuthorization = (
  next: Catalogue,
  previous: Catalogue,
  environment: EnvironmentName,
) => void | Promise<void>;
const Revision = z.string().regex(/^[a-f0-9]{64}$/);
const OperationSchema = z.object({
  id: Revision,
  createdAt: z.string().datetime(),
  actor: z.string(),
  reason: z.string(),
  environments: z.array(Environment),
  revisions: z.record(Revision),
  type: z.enum(['publish', 'rollback']),
});
export type CatalogueOperation = z.infer<typeof OperationSchema>;
const Permission = z.object({
  name: z.string(),
  description: z.string().nullable().optional(),
  owner: z.string(),
});
const Role = z.object({
  name: z.string(),
  description: z.string().nullable().optional(),
  permissions: z.array(z.string()),
});
const Scope = z.object({
  clientId: z.string(),
  enabled: z.boolean(),
  permissions: z.array(z.string()),
});
const RegistrySchema = z.object({
  environment: Environment,
  generation: z.number().int().positive(),
  revision: Revision,
  permissions: z.array(Permission),
  roles: z.array(Role),
  groups: z.array(z.object({ name: z.string(), roles: z.array(z.string()) })),
  clientTokenScopes: z.array(Scope).nullable().optional(),
  accessRules: z.array(z.unknown()).nullable().optional(),
  managedAccessClients: z.array(z.string()).nullable().optional(),
  ownershipMigrations: z.array(z.unknown()).optional(),
});
const State = z.object({ registry: RegistrySchema, catalogue: CatalogueSchema });
export class CatalogueService {
  private readonly provider: ProviderCatalogueClient;
  constructor(
    private readonly config: AppConfig,
    provider?: ProviderCatalogueClient,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    this.provider = provider ?? new ProviderCatalogueClient(config, fetcher);
  }
  get environment() {
    return this.config.APP_IDENTITY_ENVIRONMENT;
  }
  private assertEnvironment(env: EnvironmentName) {
    if (env !== this.environment)
      throw new HttpError(
        403,
        'environment_not_allowed',
        'This console only manages its configured environment.',
      );
  }
  private async state(env: EnvironmentName = this.environment) {
    this.assertEnvironment(env);
    const state = State.parse(await this.provider.request());
    if (state.registry.environment !== env)
      throw new HttpError(
        503,
        'catalogue_environment',
        'The stored catalogue belongs to another environment.',
      );
    return state;
  }
  async activeRegistry() {
    const state = await this.state();
    const roles = new Set(state.catalogue.roles.map((role) => role.name));
    return {
      ...state.registry,
      roles: state.registry.roles.filter((role) => roles.has(role.name)),
    };
  }
  async current(env: EnvironmentName = this.environment) {
    const state = await this.state(env);
    return {
      baseSha: state.registry.revision,
      revision: state.registry.revision,
      environment: env,
      catalogue: state.catalogue,
    };
  }
  async assertPermissionDeletion(next: Catalogue, previous: Catalogue, bearer: string) {
    const remaining = new Set(next.permissions.map((permission) => permission.name));
    const removed = previous.permissions.filter((permission) => !remaining.has(permission.name));
    if (!removed.length) return;
    const base = (
      this.config.APP_KEYCLOAK_TRANSPORT_URL ?? this.config.APP_KEYCLOAK_ISSUER
    ).replace(/\/$/, '');
    const response = await this.fetcher(base + '/score-applications', {
      headers: { Authorization: `Bearer ${bearer}` },
      redirect: 'error',
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok)
      throw new HttpError(
        503,
        'application_dependencies_unavailable',
        'Application dependencies could not be verified. No change was saved.',
      );
    const result = z
      .object({
        applications: z.array(
          z.object({ name: z.string(), requiredPermissions: z.array(z.string()) }),
        ),
      })
      .safeParse(await response.json());
    if (!result.success)
      throw new HttpError(
        502,
        'invalid_provider_response',
        'Application dependencies could not be verified. No change was saved.',
      );
    const removedNames = new Set(removed.map((permission) => permission.name));
    const dependents = result.data.applications.filter((application) =>
      application.requiredPermissions.some((permission) => removedNames.has(permission)),
    );
    if (dependents.length)
      throw new HttpError(
        409,
        'permission_in_use',
        'Change the required permissions in Applications before deleting this permission.',
      );
  }

  async publish(
    baseSha: string,
    input: Catalogue,
    reason: string,
    actor: string,
    environments: EnvironmentName[] = [this.environment],
    sourceEnvironment: EnvironmentName = this.environment,
    authorize?: CatalogueAuthorization,
  ) {
    this.assertEnvironment(sourceEnvironment);
    return this.apply(baseSha, input, reason, actor, environments, 'publish', authorize);
  }
  private async apply(
    baseSha: string,
    input: Catalogue,
    reason: string,
    actor: string,
    environments: EnvironmentName[],
    type: 'publish' | 'rollback',
    authorize?: CatalogueAuthorization,
  ) {
    Revision.parse(baseSha);
    z.string().trim().min(8).max(300).parse(reason);
    z.string().min(1).max(200).parse(actor);
    if (environments.length !== 1)
      throw new HttpError(422, 'invalid_environment', 'Select this environment only.');
    this.assertEnvironment(Environment.parse(environments[0]));
    const { registry: old, catalogue: previous } = await this.state();
    if (old.revision !== baseSha)
      throw new HttpError(
        409,
        'stale_catalogue',
        'The catalogue has changed. Reload before saving.',
      );
    const next = validateCatalogue(input, previous);
    await authorize?.(next, previous, this.environment);
    const permissions = new Set(next.permissions.map((permission) => permission.name));
    const roleNames = new Set(next.roles.map((role) => role.name));
    const archived = old.roles
      .filter((role) => !roleNames.has(role.name))
      .map((role) => ({ ...role, permissions: [] }));
    const managedClients = new Set(old.managedAccessClients ?? []);
    for (const rule of previous.accessRules ?? []) managedClients.add(rule.clientId);
    const tokenScopes = new Map(
      (old.clientTokenScopes ?? []).map((scope) => [scope.clientId, structuredClone(scope)]),
    );
    for (const rule of next.accessRules ?? []) {
      if (tokenScopes.has(rule.clientId) && !managedClients.has(rule.clientId))
        throw new HttpError(
          422,
          'service_owned_client',
          'This client has a service-owned token contract.',
        );
      managedClients.add(rule.clientId);
    }
    for (const clientId of managedClients)
      tokenScopes.set(clientId, {
        clientId,
        enabled: true,
        permissions:
          next.accessRules?.find((rule) => rule.clientId === clientId)?.requiredPermissions ?? [],
      });
    const admin = tokenScopes.get('identity-admin-web');
    if (admin) admin.permissions = [...permissions].sort();
    if (
      [...tokenScopes.values()].some((scope) =>
        scope.permissions.some((permission) => !permissions.has(permission)),
      )
    )
      throw new HttpError(
        409,
        'permission_in_use',
        'A service-owned token scope still requires this permission.',
      );
    const registry = {
      ...old,
      generation: old.generation + 1,
      permissions: next.permissions.map((permission) => ({
        ...permission,
        owner:
          old.permissions.find((current) => current.name === permission.name)?.owner ??
          'scoretech-catalogue',
      })),
      roles: [...next.roles, ...archived],
      groups: next.groups,
      accessRules: next.accessRules ?? [],
      managedAccessClients: [...managedClients].sort(),
      clientTokenScopes: [...tokenScopes.values()],
      revision: createHash('sha256')
        .update(JSON.stringify({ baseSha, next, reason, actor, nonce: randomUUID() }))
        .digest('hex'),
    };
    const operation = OperationSchema.parse(
      await this.provider.request('', 'POST', {
        baseRevision: baseSha,
        registry,
        roleNames: [...roleNames],
        actor,
        reason,
        type,
      }),
    );
    return operation;
  }
  async revisions(): Promise<CatalogueOperation[]> {
    return OperationSchema.array().parse(await this.provider.request('/revisions'));
  }
  async snapshot(env: EnvironmentName, revision: string) {
    this.assertEnvironment(env);
    Revision.parse(revision);
    return z
      .object({ catalogue: CatalogueSchema })
      .parse(await this.provider.request('/revisions/' + revision));
  }
  async rollback(
    baseSha: string,
    id: string,
    environments: EnvironmentName[],
    reason: string,
    actor: string,
    authorize?: CatalogueAuthorization,
  ) {
    const historical = await this.snapshot(this.environment, id);
    const previous = (await this.current()).catalogue;
    const permissions = new Set(previous.permissions.map((permission) => permission.name));
    const roles = new Set(historical.catalogue.roles.map((role) => role.name));
    const catalogue = {
      ...historical.catalogue,
      permissions: previous.permissions,
      roles: historical.catalogue.roles.map((role) =>
        role.name === 'administrador'
          ? {
              ...previous.roles.find((current) => current.name === 'administrador')!,
              permissions: [...permissions],
            }
          : {
              ...role,
              permissions: role.permissions.filter(
                (permission) => permissions.has(permission) || roles.has(permission),
              ),
            },
      ),
    };
    return this.apply(baseSha, catalogue, reason, actor, environments, 'rollback', authorize);
  }
  assignmentRoles(env: EnvironmentName): Promise<string[]> {
    this.assertEnvironment(env);
    return this.provider.projection().then((projection) => projection.roles);
  }
  async status(env: EnvironmentName) {
    const { registry } = await this.state(env);
    return {
      environment: env,
      revision: registry.revision,
      desiredRevision: registry.revision,
      observedRevision: registry.revision,
      generation: registry.generation,
      enabled: true,
      state: 'applied',
      detail: 'Changes are saved and active in the identity database.',
    };
  }
}
