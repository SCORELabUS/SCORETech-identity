import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { AppConfig } from '../../config/app-config.js';
import { HttpError } from '../../shared/http/errors.js';
import { Github } from './github.js';
import {
  dumpYaml,
  parseYaml,
  readCatalogue,
  validateCatalogue,
  writeCatalogue,
  type Catalogue,
} from './catalogue-model.js';
export const CATALOGUE_PATH = 'environments/identity/catalogue.yaml';
const BOOTSTRAP_PATH = 'environments/identity/identity-config-sync-values.yaml';
const GENERATED_ROOT = 'environments/identity/generated';
const LEGACY_REVISIONS_ROOT = 'environments/identity/revisions';
const LEGACY_ENVIRONMENTS_ROOT = 'environments/identity/environments';
const LEGACY_OPERATIONS_ROOT = 'environments/identity/operations';
const Revision = z.string().regex(/^[a-f0-9]{40}$/);
const IdentityRevision = z.string().regex(/^[a-f0-9]{64}$/);
export const Environment = z.enum(['local', 'staging', 'production']);
export type EnvironmentName = z.infer<typeof Environment>;
export type CatalogueAuthorization = (
  next: Catalogue,
  previous: Catalogue,
  environment: EnvironmentName,
) => void | Promise<void>;
const Overlay = z
  .object({
    service: z.enum(['identity-config-sync', 'identity-account-api']),
    repo: z.string(),
    version: z.string(),
    namespace: z.string(),
    enabled: z.union([z.string(), z.boolean()]).optional(),
    valueFiles: z.array(z.string()).optional(),
    values: z.record(z.unknown()).optional(),
  })
  .passthrough();
const OperationSchema = z.object({
  id: IdentityRevision,
  createdAt: z.string().datetime(),
  actor: z.string(),
  reason: z.string(),
  environments: z.array(Environment),
  revisions: z.record(IdentityRevision),
  type: z.enum(['publish', 'rollback']),
});
export type CatalogueOperation = z.infer<typeof OperationSchema>;
const snapshotReference = (file: string) =>
  file === BOOTSTRAP_PATH ||
  /^environments\/identity\/(?:generated\/)?revisions\/(?:[a-zA-Z0-9_-]+\/)*(?:[a-f0-9]{40}|[a-f0-9]{64})\.yaml$/.test(
    file,
  );
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(',')}}`;
  return JSON.stringify(value);
};
const digest = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
type CurrentCatalogue = {
  baseSha: string;
  environment: EnvironmentName;
  revision: unknown;
  catalogue: Catalogue;
};
export class CatalogueService {
  readonly github: Github;
  private currentHead?: Promise<string>;
  private currentSnapshots = new Map<
    EnvironmentName,
    { sha: string; value: Promise<CurrentCatalogue> }
  >();
  constructor(
    private readonly config: AppConfig,
    github?: Github,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    this.github = github ?? new Github(config);
  }
  get environment() {
    return this.config.APP_IDENTITY_ENVIRONMENT;
  }
  private async fileWithFallback(paths: string[], ref: string) {
    let lastError: HttpError | undefined;
    for (const path of paths) {
      try {
        return { path, text: await this.github.file(path, ref) };
      } catch (error) {
        if (!(error instanceof HttpError) || error.status !== 404) throw error;
        lastError = error;
      }
    }
    if (lastError) throw lastError;
    throw new Error('No GitHub paths provided.');
  }
  private async optionalFileWithFallback(paths: string[], ref: string) {
    try {
      return await this.fileWithFallback(paths, ref);
    } catch (error) {
      if (error instanceof HttpError && error.status === 404) return undefined;
      throw error;
    }
  }
  private operationPaths(id: string) {
    return [`${GENERATED_ROOT}/operations/${id}.yaml`, `${LEGACY_OPERATIONS_ROOT}/${id}.yaml`];
  }
  private async operationIds(ref: string) {
    const indexes = await Promise.all([
      this.optionalFileWithFallback([`${GENERATED_ROOT}/operations/index.yaml`], ref),
      this.optionalFileWithFallback([`${LEGACY_OPERATIONS_ROOT}/index.yaml`], ref),
    ]);
    const ids = new Set<string>();
    for (const index of indexes) {
      if (!index) continue;
      for (const id of z.array(IdentityRevision).max(100).parse(parseYaml(index.text))) ids.add(id);
    }
    return { found: indexes.some(Boolean), ids: [...ids].slice(0, 100) };
  }
  private snapshotPaths(env: EnvironmentName, id: string) {
    return [
      `${GENERATED_ROOT}/revisions/${env}/${id}.yaml`,
      `${LEGACY_REVISIONS_ROOT}/${env}/${id}.yaml`,
    ];
  }
  private async environmentSource(env: EnvironmentName, ref: string) {
    const overlayPath = `environments/${env}/identity-config-sync.yaml`;
    const overlay = Overlay.parse(parseYaml(await this.github.file(overlayPath, ref)));
    const paths = overlay.valueFiles?.filter(snapshotReference) ?? [];
    if (paths.length !== 1)
      throw new HttpError(
        409,
        'overlay_contract',
        `${env} requires exactly one identity snapshot reference.`,
      );
    return { overlay, overlayPath, path: paths[0]!, text: await this.github.file(paths[0]!, ref) };
  }
  async current(env: EnvironmentName = this.config.APP_IDENTITY_ENVIRONMENT) {
    const environment = Environment.parse(env);
    // Check HEAD on every read, coalescing only concurrent requests. The parsed
    // catalogue is immutable at a commit SHA; no TTL can retain removed roles.
    const head = (this.currentHead ??= this.github.head());
    let baseSha: string;
    try {
      baseSha = await head;
    } finally {
      if (this.currentHead === head) this.currentHead = undefined;
    }
    let cached = this.currentSnapshots.get(environment);
    if (!cached || cached.sha !== baseSha) {
      const value = (async (): Promise<CurrentCatalogue> => {
        const source = await this.environmentSource(environment, baseSha);
        const data = parseYaml(source.text) as Record<string, unknown>;
        const registry = data.authorizationRegistry as Record<string, unknown> | undefined;
        return {
          baseSha,
          environment,
          revision:
            registry?.revision ??
            source.path.match(/([a-f0-9]{40}|[a-f0-9]{64})\.yaml$/)?.[1] ??
            null,
          catalogue: readCatalogue(data),
        };
      })();
      cached = { sha: baseSha, value };
      this.currentSnapshots.set(environment, cached);
    }
    try {
      // Editors and callers must never mutate the shared parsed snapshot.
      return structuredClone(await cached.value);
    } catch (error) {
      if (this.currentSnapshots.get(environment) === cached)
        this.currentSnapshots.delete(environment);
      throw error;
    }
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
    environments: EnvironmentName[] = [this.config.APP_IDENTITY_ENVIRONMENT],
    sourceEnvironment: EnvironmentName = this.config.APP_IDENTITY_ENVIRONMENT,
    authorize?: CatalogueAuthorization,
  ) {
    const source = await this.environmentSource(
      Environment.parse(sourceEnvironment),
      Revision.parse(baseSha),
    );
    const catalogue = validateCatalogue(input, readCatalogue(source.text));
    return this.apply(baseSha, catalogue, reason, actor, environments, 'publish', authorize);
  }
  private async apply(
    baseSha: string,
    catalogueInput: Catalogue | Partial<Record<EnvironmentName, Catalogue>>,
    reason: string,
    actor: string,
    environments: EnvironmentName[],
    type: 'publish' | 'rollback',
    authorize?: CatalogueAuthorization,
  ) {
    Revision.parse(baseSha);
    z.string().trim().min(8).max(300).parse(reason);
    z.string().min(1).max(200).parse(actor);
    const targets = z.array(Environment).min(1).max(2).parse(environments);
    if (new Set(targets).size !== targets.length)
      throw new HttpError(422, 'duplicate_environment', 'Duplicate target environment.');
    const files: { path: string; content: string }[] = [];
    const revisions: Record<string, string> = {};
    for (const env of targets) {
      const catalogue = 'roles' in catalogueInput ? catalogueInput : catalogueInput[env];
      if (!catalogue)
        throw new HttpError(
          422,
          'missing_revision',
          'The revision does not include this environment.',
        );
      const source = await this.environmentSource(env, baseSha);
      if (!['true', true].includes(source.overlay.enabled ?? false))
        throw new HttpError(409, 'environment_disabled', `${env} is not enabled.`);
      if (
        source.overlay.values &&
        ('realm' in source.overlay.values ||
          'permissions' in source.overlay.values ||
          'authorizationRegistry' in source.overlay.values)
      )
        throw new HttpError(409, 'overlay_override', `${env} overrides identity configuration.`);
      const previous = readCatalogue(source.text);
      const sourceRegistry = (parseYaml(source.text) as Record<string, unknown>)
        .authorizationRegistry as Record<string, unknown> | undefined;
      if (sourceRegistry?.enabled !== true)
        throw new HttpError(
          409,
          'registry_not_ready',
          `${env} must complete transactional identity setup before editing roles.`,
        );
      const selectedPermissions =
        type === 'rollback' ? previous.permissions : catalogue.permissions;
      const permissions = new Set(selectedPermissions.map((item) => item.name));
      const roleNames = new Set(catalogue.roles.map((item) => item.name));
      const roles = catalogue.roles.map((role) =>
        role.name === 'administrador'
          ? {
              ...previous.roles.find((item) => item.name === 'administrador')!,
              permissions: [...permissions].sort(),
            }
          : {
              ...role,
              permissions:
                type === 'rollback'
                  ? role.permissions.filter(
                      (permission) => permissions.has(permission) || roleNames.has(permission),
                    )
                  : role.permissions.map((permission) =>
                      permission.replace(/:(?:local|staging|production):access$/, `:${env}:access`),
                    ),
            },
      );
      const next = validateCatalogue({
        defaultRole: catalogue.defaultRole ?? previous.defaultRole,
        permissions: selectedPermissions,
        roles,
        groups: catalogue.groups,
        accessRules: catalogue.accessRules ?? previous.accessRules ?? [],
      });
      await authorize?.(next, previous, env);
      const data = parseYaml(writeCatalogue(next, source.text)) as Record<string, unknown>;
      const old = (data.authorizationRegistry ?? {}) as Record<string, unknown>;
      const archived = Array.isArray(old.roles)
        ? (old.roles as Catalogue['roles'])
            .filter((role) => !roleNames.has(role.name))
            .map((role) => ({ ...role, permissions: [] }))
        : previous.roles
            .filter((role) => !roleNames.has(role.name))
            .map((role) => ({ ...role, permissions: [] }));
      const oldPermissions = Array.isArray(old.permissions)
        ? (old.permissions as { name: string; owner?: string }[])
        : [];
      const managedClients = new Set(
        Array.isArray(old.managedAccessClients) ? (old.managedAccessClients as string[]) : [],
      );
      for (const rule of previous.accessRules ?? []) managedClients.add(rule.clientId);
      const tokenScopes = new Map(
        (Array.isArray(old.clientTokenScopes)
          ? (old.clientTokenScopes as {
              clientId: string;
              enabled: boolean;
              permissions: string[];
            }[])
          : []
        ).map((scope) => [scope.clientId, structuredClone(scope)]),
      );
      for (const rule of next.accessRules ?? []) {
        if (tokenScopes.has(rule.clientId) && !managedClients.has(rule.clientId))
          throw new HttpError(
            422,
            'service_owned_client',
            'This client has a service-owned token contract and cannot be managed by access rules.',
          );
        managedClients.add(rule.clientId);
      }
      // Retired rules leave an empty, restricted token scope, never full scope.
      for (const clientId of managedClients)
        tokenScopes.set(clientId, {
          clientId,
          enabled: true,
          permissions:
            (next.accessRules ?? []).find((rule) => rule.clientId === clientId)
              ?.requiredPermissions ?? [],
        });
      const adminScope = tokenScopes.get('identity-admin-web');
      if (adminScope) adminScope.permissions = [...permissions].sort();
      if (
        [...tokenScopes.values()].some((scope) =>
          scope.permissions.some((permission) => !permissions.has(permission)),
        )
      )
        throw new HttpError(
          409,
          'permission_in_use',
          'A service-owned token scope still requires this permission. Update that contract before deleting it.',
        );
      data.authorizationRegistry = {
        enabled: true,
        environment: env,
        generation: Number(old.generation ?? 0) + 1,
        permissions: next.permissions.map((permission) => ({
          ...permission,
          owner:
            oldPermissions.find((item) => item.name === permission.name)?.owner ??
            'scoretech-catalogue',
        })),
        roles: [...next.roles, ...archived],
        groups: next.groups,
        accessRules: next.accessRules ?? [],
        managedAccessClients: [...managedClients].sort(),
        ...(Array.isArray(old.clientTokenScopes) || managedClients.size
          ? { clientTokenScopes: [...tokenScopes.values()] }
          : {}),
      };
      const revision = digest(data);
      (data.authorizationRegistry as Record<string, unknown>).revision = revision;
      const path = `${GENERATED_ROOT}/revisions/${env}/${revision}.yaml`;
      revisions[env] = revision;
      files.push({ path, content: dumpYaml(data) });
      source.overlay.valueFiles = source.overlay.valueFiles!.map((value) =>
        value === source.path ? path : value,
      );
      files.push({ path: source.overlayPath, content: dumpYaml(source.overlay) });
      const accountPath = `environments/${env}/identity-account-api.yaml`;
      const account = Overlay.parse(parseYaml(await this.github.file(accountPath, baseSha)));
      if (
        account.service !== 'identity-account-api' ||
        account.valueFiles?.filter(snapshotReference).length !== 1 ||
        (account.values &&
          ('realm' in account.values ||
            'permissions' in account.values ||
            'authorizationRegistry' in account.values))
      )
        throw new HttpError(
          409,
          'overlay_contract',
          `${env} account-api requires an identity reference without overrides.`,
        );
      account.valueFiles = account.valueFiles.map((value) =>
        snapshotReference(value) ? path : value,
      );
      files.push({ path: accountPath, content: dumpYaml(account) });
      const indexPath = `${GENERATED_ROOT}/environments/${env}.yaml`;
      const existingIndex = await this.optionalFileWithFallback(
        [indexPath, `${LEGACY_ENVIRONMENTS_ROOT}/${env}.yaml`],
        baseSha,
      );
      const index = existingIndex ? (parseYaml(existingIndex.text) as Record<string, unknown>) : {};
      files.push({
        path: indexPath,
        content: dumpYaml({
          ...index,
          environment: env,
          generation: (data.authorizationRegistry as Record<string, unknown>).generation,
          revision,
          valueFile: path,
          contracts: index.contracts ?? data.identityContracts ?? {},
        }),
      });
    }
    const details = {
      createdAt: new Date().toISOString(),
      actor,
      reason,
      environments: targets,
      revisions,
      type,
    };
    const operation = { id: digest(details), ...details };
    files.push({
      path: `${GENERATED_ROOT}/operations/${operation.id}.yaml`,
      content: dumpYaml(operation),
    });
    const indexPath = `${GENERATED_ROOT}/operations/index.yaml`;
    const existingOperationsIndex = await this.operationIds(baseSha);
    const previousOperationIds = existingOperationsIndex.ids;
    files.push({
      path: indexPath,
      content: dumpYaml(
        [operation.id, ...previousOperationIds.filter((id) => id !== operation.id)].slice(0, 100),
      ),
    });
    const commit = await this.github.commit(
      baseSha,
      files,
      `Identity ${type}: ${reason}\n\nActor: ${actor}`,
    );
    return { ...operation, commitSha: commit.sha, url: commit.html_url };
  }
  async revisions(): Promise<CatalogueOperation[]> {
    const ref = await this.github.head();
    const operationIndex = await this.operationIds(ref);
    if (operationIndex.found) {
      const ids = operationIndex.ids;
      return Promise.all(
        ids.map(async (id) =>
          OperationSchema.parse(
            parseYaml((await this.fileWithFallback(this.operationPaths(id), ref)).text),
          ),
        ),
      );
    }
    let entries: { name: string; path: string }[];
    try {
      entries = await this.github.entries(`${GENERATED_ROOT}/operations`, ref);
    } catch (error) {
      if (!(error instanceof HttpError) || error.status !== 404) throw error;
      try {
        entries = await this.github.entries(LEGACY_OPERATIONS_ROOT, ref);
      } catch (legacyError) {
        if (legacyError instanceof HttpError && legacyError.status === 404) return [];
        throw legacyError;
      }
    }
    const history = await Promise.all(
      entries
        .filter((entry) => entry.name !== 'index.yaml')
        .map(async (entry) =>
          OperationSchema.parse(parseYaml(await this.github.file(entry.path, ref))),
        ),
    );
    return history.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 100);
  }
  async rollback(
    baseSha: string,
    id: string,
    environments: EnvironmentName[],
    reason: string,
    actor: string,
    authorize?: CatalogueAuthorization,
  ) {
    IdentityRevision.parse(id);
    const operation = OperationSchema.parse(
      parseYaml(
        (await this.fileWithFallback(this.operationPaths(id), Revision.parse(baseSha))).text,
      ),
    );
    const { id: storedId, ...details } = operation;
    if (storedId !== digest(details))
      throw new HttpError(409, 'changed_operation', 'The revision history has been modified.');
    if (operation.id !== id)
      throw new HttpError(409, 'invalid_operation', 'The revision does not match its history.');
    const targets = z.array(Environment).min(1).max(2).parse(environments);
    const historical: Partial<Record<EnvironmentName, Catalogue>> = {};
    for (const env of targets) {
      const revision = operation.revisions[env];
      if (!revision)
        throw new HttpError(
          422,
          'missing_revision',
          'The revision does not include this environment.',
        );
      const paths = this.snapshotPaths(env, IdentityRevision.parse(revision));
      const text = (await this.fileWithFallback(paths, baseSha)).text;
      const data = parseYaml(text) as Record<string, unknown>;
      const registry = data.authorizationRegistry as Record<string, unknown>;
      if (!registry || registry.revision !== revision)
        throw new HttpError(409, 'invalid_snapshot', 'The revision does not match the snapshot.');
      const withoutRevision = { ...data, authorizationRegistry: { ...registry } };
      delete (withoutRevision.authorizationRegistry as Record<string, unknown>).revision;
      if (digest(withoutRevision) !== revision)
        throw new HttpError(409, 'changed_snapshot', 'Snapshot integrity verification failed.');
      historical[env] = readCatalogue(text);
    }
    return this.apply(baseSha, historical, reason, actor, targets, 'rollback', authorize);
  }
  async snapshot(env: EnvironmentName, revision: string) {
    IdentityRevision.parse(revision);
    const ref = await this.github.head();
    const text = (await this.fileWithFallback(this.snapshotPaths(env, revision), ref)).text;
    const data = parseYaml(text) as Record<string, unknown>;
    const registry = data.authorizationRegistry as Record<string, unknown> | undefined;
    if (!registry || registry.revision !== revision || registry.environment !== env)
      throw new HttpError(
        409,
        'invalid_snapshot',
        'The revision does not match the requested environment.',
      );
    const canonical = { ...data, authorizationRegistry: { ...registry } };
    delete (canonical.authorizationRegistry as Record<string, unknown>).revision;
    if (digest(canonical) !== revision)
      throw new HttpError(409, 'changed_snapshot', 'Snapshot integrity verification failed.');
    return { catalogue: readCatalogue(text) };
  }
  private activeCatalogue(): { permissions: string[]; roles: string[] } {
    return z
      .object({ permissions: z.array(z.string()), roles: z.array(z.string()) })
      .strict()
      .parse(JSON.parse(readFileSync(this.config.APP_AUTHORIZATION_CATALOGUE_PATH, 'utf8')));
  }
  assignmentRoles(env: EnvironmentName): Promise<string[]> {
    return Promise.resolve().then(() => {
      if (env !== this.config.APP_IDENTITY_ENVIRONMENT)
        throw new HttpError(
          403,
          'environment_not_allowed',
          'This console only manages its configured environment.',
        );
      return this.activeCatalogue().roles;
    });
  }
  async status(env: EnvironmentName) {
    if (env !== this.config.APP_IDENTITY_ENVIRONMENT)
      throw new HttpError(
        403,
        'environment_not_allowed',
        'This console only manages its configured environment.',
      );
    let observed: Record<string, unknown> = {};
    try {
      observed = JSON.parse(readFileSync(this.config.APP_CATALOGUE_STATE_PATH, 'utf8')) as Record<
        string,
        unknown
      >;
    } catch {
      /* No applied snapshot has been reported. */
    }
    const current = await this.current(env);
    const desired = typeof current.revision === 'string' ? current.revision : null;
    const applied = observed.observedRevision ?? null;
    const belongsToDesired =
      observed.desiredRevision == null || observed.desiredRevision === desired;
    return {
      environment: env,
      revision: desired,
      desiredRevision: desired,
      observedRevision: applied,
      generation: observed.generation ?? null,
      enabled: true,
      state:
        desired === applied && observed.state === 'applied'
          ? 'applied'
          : belongsToDesired && observed.state === 'failed'
            ? 'failed'
            : belongsToDesired && observed.state === 'applying'
              ? 'applying'
              : 'pending',
      detail:
        desired === applied && observed.state === 'applied'
          ? 'The selected revision has been verified in the identity provider.'
          : belongsToDesired
            ? (observed.detail ?? 'Waiting for the selected revision to be applied.')
            : 'Waiting for the selected revision to be applied.',
    };
  }
}
