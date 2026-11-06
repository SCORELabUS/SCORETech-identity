import { afterEach, describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/main/config/app-config.js';
import { CatalogueService } from '../src/main/modules/catalogue/catalogue-service.js';
import { assertCatalogueDelegation } from '../src/main/modules/catalogue/catalogue.routes.js';
import {
  readCatalogue,
  validateCatalogue,
  type Catalogue,
  type AccessRule,
} from '../src/main/modules/catalogue/catalogue-model.js';
import { Github } from '../src/main/modules/catalogue/github.js';
import { HttpError } from '../src/main/shared/http/errors.js';

const baseSha = 'a'.repeat(40);
const commitSha = 'b'.repeat(40);
const initialRevision = 'c'.repeat(64);
const manage = 'identity:roles:manage';
const view = 'identity:users:view';
const read = 'sphere:read';
const initialPermissions = [manage, view, read, 'admin-web:local:access'];
const newPermission = { name: 'space:local:access', description: 'Use SPACE' };
const actor = '11111111-1111-4111-8111-111111111111';
const settings = loadConfig({
  APP_CORS_ORIGINS: 'http://localhost:18000',
  APP_KEYCLOAK_ISSUER: 'https://identity.example.test/identity/auth/realms/score',
  APP_KEYCLOAK_ADMIN_URL: 'http://identity:8080/identity/auth',
  APP_KEYCLOAK_REALM: 'score',
  APP_KEYCLOAK_ADMIN_CLIENT_SECRET: 'fixture-only',
  APP_IDENTITY_ENVIRONMENT: 'local',
});
type TokenScope = { clientId: string; enabled: boolean; permissions: string[] };
type PublishedSnapshot = {
  authorizationRegistry: {
    revision: string;
    generation: number;
    permissions: { name: string; description: string; owner: string }[];
    roles: Catalogue['roles'];
    accessRules: AccessRule[];
    managedAccessClients: string[];
    clientTokenScopes: TokenScope[];
  };
};
type FileChange = { path: string; content: string };
const directories: string[] = [];
afterEach(() => {
  directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true }));
});

const baseCatalogue = (): Catalogue =>
  validateCatalogue({
    defaultRole: 'member',
    permissions: initialPermissions.map((name) => ({ name, description: name })),
    roles: [
      {
        name: 'administrador',
        description: 'Identity administrator',
        permissions: [...initialPermissions],
      },
      { name: 'member', description: 'Member', permissions: [] },
      { name: 'reader', description: 'Read SPHERE', permissions: [read] },
    ],
    groups: [],
  });

function fixtureSource() {
  const catalogue = baseCatalogue();
  const permissions: Record<string, { name: string; description: string }[]> = {};
  for (const permission of catalogue.permissions) {
    const [domain, ...rest] = permission.name.split(':');
    (permissions[domain!] ??= []).push({
      name: rest.join(':'),
      description: permission.description,
    });
  }
  return {
    permissions,
    realm: {
      name: 'score',
      settings: { defaultRole: { name: 'member' } },
      roles: {
        realm: catalogue.roles.map((role) => ({
          name: role.name,
          description: role.description,
          composites: { realm: role.permissions },
        })),
      },
      groups: [],
    },
    authorizationRegistry: {
      enabled: true,
      environment: 'local',
      generation: 1,
      revision: initialRevision,
      permissions: catalogue.permissions.map((permission) => ({
        ...permission,
        owner: permission.name.startsWith('identity:')
          ? 'identity-admin-api'
          : permission.name.startsWith('admin-web:')
            ? 'identity-admin-web'
            : 'sphere-api',
      })),
      roles: catalogue.roles,
      groups: [],
      accessRules: [] as AccessRule[],
      managedAccessClients: [] as string[],
      clientTokenScopes: [
        { clientId: 'identity-admin-web', enabled: true, permissions: [...initialPermissions] },
        { clientId: 'identity-account-web', enabled: true, permissions: [] },
        { clientId: 'analytics-web', enabled: true, permissions: [read] },
      ],
    },
  };
}

function fixture(source = fixtureSource(), statePath?: string) {
  const snapshotPath = `environments/identity/generated/revisions/local/${initialRevision}.yaml`;
  const syncPath = 'environments/local/identity-config-sync.yaml';
  const accountPath = 'environments/local/identity-account-api.yaml';
  const overlay = (service: string) => ({
    service,
    repo: 'SCORELabUS/SCORETech-identity',
    namespace: 'local-platform',
    version: '0.1.0',
    enabled: true,
    valueFiles: [snapshotPath],
  });
  const files = new Map([
    [snapshotPath, JSON.stringify(source)],
    [syncPath, JSON.stringify(overlay('identity-config-sync'))],
    [accountPath, JSON.stringify(overlay('identity-account-api'))],
    ['environments/identity/generated/operations/index.yaml', '[]'],
  ]);
  const file = vi.fn(async (path: string) => {
    const value = files.get(path);
    if (value === undefined)
      throw new HttpError(404, 'missing_fixture_file', 'Fixture file not found.');
    return value;
  });
  const github = {
    file,
    head: vi.fn().mockResolvedValue(baseSha),
    commit: vi.fn(async (_base: string, changes: FileChange[]) => {
      changes.forEach((change) => files.set(change.path, change.content));
      return { sha: commitSha, html_url: 'https://example.test/fixture-commit' };
    }),
  };
  const service = new CatalogueService(
    statePath ? { ...settings, APP_CATALOGUE_STATE_PATH: statePath } : settings,
    github as unknown as Github,
  );
  const publish = (input: Catalogue) =>
    service.publish(
      baseSha,
      input,
      'Publish application authorization',
      actor,
      ['local'],
      'local',
      (next, previous) =>
        assertCatalogueDelegation(
          {
            roles: [...initialPermissions],
            effectiveRoleNames: [...initialPermissions, 'administrador'],
          },
          next,
          previous,
        ),
    );
  const published = (call = 0) => {
    const changes = github.commit.mock.calls[call]![1];
    const snapshot = changes.find((change) =>
      /generated\/revisions\/local\/[a-f0-9]{64}\.yaml$/.test(change.path),
    );
    if (!snapshot) throw new Error('No immutable snapshot was published.');
    return {
      path: snapshot.path,
      data: parse(snapshot.content) as PublishedSnapshot,
      catalogue: readCatalogue(snapshot.content),
      changes,
    };
  };
  return { source, files, syncPath, accountPath, github, service, publish, published };
}

const rule = (): AccessRule => ({
  id: 'space-local',
  clientId: 'space-web',
  origin: 'https://space.score.us.es',
  requiredPermissions: [newPermission.name],
});
const inputWithNewPermission = (): Catalogue => ({
  ...baseCatalogue(),
  permissions: [...baseCatalogue().permissions, newPermission],
  accessRules: [rule()],
});

describe('application access publication preserves provider ownership boundaries', () => {
  it.each(['failed', 'applying'])(
    'reports a newly published desired revision as pending instead of retaining a stale %s status',
    async (state) => {
      const directory = mkdtempSync(join(tmpdir(), 'score-publication-status-'));
      directories.push(directory);
      const statePath = join(directory, 'apply-status.json');
      const observedRevision = 'f'.repeat(64);
      writeFileSync(
        statePath,
        JSON.stringify({
          state,
          desiredRevision: initialRevision,
          observedRevision,
          generation: 1,
          detail: 'The old desired revision could not be verified.',
        }),
      );
      const f = fixture(fixtureSource(), statePath);
      await expect(f.service.status('local')).resolves.toMatchObject({
        state,
        desiredRevision: initialRevision,
        observedRevision,
      });
      const published = await f.publish(inputWithNewPermission());
      f.github.head.mockResolvedValue(commitSha);
      await expect(f.service.status('local')).resolves.toMatchObject({
        state: 'pending',
        desiredRevision: published.revisions.local,
        observedRevision,
        detail: 'Waiting for the selected revision to be applied.',
      });
    },
  );

  it('publishes new atoms and exact client scopes while preserving service owners and unrelated contracts', async () => {
    const f = fixture();
    const originalOwners = structuredClone(f.source.authorizationRegistry.permissions);
    const originalScopes = structuredClone(f.source.authorizationRegistry.clientTokenScopes);
    const result = await f.publish(inputWithNewPermission());
    const { data, catalogue, changes, path } = f.published();
    const registry = data.authorizationRegistry;
    expect(registry.permissions).toEqual(expect.arrayContaining(originalOwners));
    expect(
      registry.permissions.find((permission) => permission.name === newPermission.name),
    ).toEqual({ ...newPermission, owner: 'scoretech-catalogue' });
    expect(registry.roles.find((role) => role.name === 'administrador')!.permissions).toEqual(
      catalogue.permissions.map(({ name }) => name).sort(),
    );
    expect(
      registry.clientTokenScopes.find((scope) => scope.clientId === 'identity-admin-web')!
        .permissions,
    ).toEqual(catalogue.permissions.map(({ name }) => name).sort());
    expect(
      registry.clientTokenScopes.filter((scope) =>
        ['identity-account-web', 'analytics-web'].includes(scope.clientId),
      ),
    ).toEqual(originalScopes.filter((scope) => scope.clientId !== 'identity-admin-web'));
    expect(registry.clientTokenScopes.find((scope) => scope.clientId === rule().clientId)).toEqual({
      clientId: rule().clientId,
      enabled: true,
      permissions: rule().requiredPermissions,
    });
    expect(registry.accessRules).toEqual([rule()]);
    expect(registry.managedAccessClients).toEqual([rule().clientId]);
    expect(registry.generation).toBe(2);
    expect(path).toContain(registry.revision);
    expect(result.revisions.local).toBe(registry.revision);
    for (const overlayPath of [f.syncPath, f.accountPath])
      expect(
        parse(changes.find((change) => change.path === overlayPath)!.content).valueFiles,
      ).toEqual([path]);
    const operation = changes.find((change) =>
      change.path.endsWith(`/operations/${result.id}.yaml`),
    )!;
    expect(parse(operation.content)).toMatchObject({
      actor,
      reason: 'Publish application authorization',
      type: 'publish',
      revisions: { local: registry.revision },
    });
  });

  it('keeps removed rule clients restricted with an enabled empty token scope', async () => {
    const f = fixture();
    await f.publish(inputWithNewPermission());
    const next = f.published().catalogue;
    next.accessRules = [];
    await f.publish(next);
    const registry = f.published(1).data.authorizationRegistry;
    expect(registry.accessRules).toEqual([]);
    expect(registry.managedAccessClients).toContain(rule().clientId);
    expect(registry.clientTokenScopes.find((scope) => scope.clientId === rule().clientId)).toEqual({
      clientId: rule().clientId,
      enabled: true,
      permissions: [],
    });
    expect(registry.clientTokenScopes.find((scope) => scope.clientId === 'analytics-web')).toEqual(
      f.source.authorizationRegistry.clientTokenScopes.find(
        (scope) => scope.clientId === 'analytics-web',
      ),
    );
  });

  it('replaces a managed rule scope precisely without expanding unrelated client grants', async () => {
    const f = fixture();
    await f.publish(inputWithNewPermission());
    const next = f.published().catalogue;
    next.accessRules![0]!.requiredPermissions = [read];
    await f.publish(next);
    const registry = f.published(1).data.authorizationRegistry;
    expect(
      registry.clientTokenScopes.find((scope) => scope.clientId === rule().clientId)!.permissions,
    ).toEqual([read]);
    expect(
      registry.clientTokenScopes.find((scope) => scope.clientId === 'analytics-web')!.permissions,
    ).toEqual([read]);
    expect(
      registry.permissions.find((permission) => permission.name === newPermission.name)!.owner,
    ).toBe('scoretech-catalogue');
  });

  it('rejects taking over an existing service-owned client scope before any Git write', async () => {
    const f = fixture();
    const next = inputWithNewPermission();
    next.accessRules![0]!.clientId = 'analytics-web';
    await expect(f.publish(next)).rejects.toMatchObject({
      status: 422,
      code: 'service_owned_client',
    });
    expect(f.github.commit).not.toHaveBeenCalled();
  });

  it('does not publish partial changes when source retrieval fails', async () => {
    const f = fixture();
    f.github.file.mockRejectedValueOnce(
      new HttpError(503, 'source_unavailable', 'Fixture source unavailable.'),
    );
    await expect(f.publish(inputWithNewPermission())).rejects.toMatchObject({
      status: 503,
      code: 'source_unavailable',
    });
    expect(f.github.commit).not.toHaveBeenCalled();
  });

  it('does not write a prepared revision when a downstream account overlay violates the contract', async () => {
    const f = fixture();
    const overlay = parse(f.files.get(f.accountPath)!) as Record<string, unknown>;
    overlay.values = { permissions: {} };
    f.files.set(f.accountPath, JSON.stringify(overlay));
    await expect(f.publish(inputWithNewPermission())).rejects.toMatchObject({
      status: 409,
      code: 'overlay_contract',
    });
    expect(f.github.commit).not.toHaveBeenCalled();
  });

  it('uses the real Git commit CAS to reject a stale base before tree or ref writes', async () => {
    const f = fixture();
    const github = new Github(settings);
    vi.spyOn(github, 'file').mockImplementation(f.github.file);
    const request = vi
      .spyOn(github, 'request')
      .mockResolvedValue({ object: { sha: 'd'.repeat(40) } });
    const service = new CatalogueService(settings, github);
    await expect(
      service.publish(
        baseSha,
        inputWithNewPermission(),
        'Reject stale application publication',
        actor,
      ),
    ).rejects.toMatchObject({ status: 409, code: 'stale_catalogue' });
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0]![0]).toContain('/git/ref/heads/');
    expect(request.mock.calls.every(([, method]) => method === undefined || method === 'GET')).toBe(
      true,
    );
    expect(f.github.commit).not.toHaveBeenCalled();
  });
});
