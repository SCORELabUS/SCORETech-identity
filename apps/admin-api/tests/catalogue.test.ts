import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { loadConfig } from '../src/main/config/app-config.js';
import {
  readCatalogue,
  validateCatalogue,
  writeCatalogue,
  AccessRuleSchema,
} from '../src/main/modules/catalogue/catalogue-model.js';
import { CatalogueService } from '../src/main/modules/catalogue/catalogue-service.js';
import { dumpYaml, parseYaml } from '../src/main/modules/catalogue/catalogue-model.js';
import { Github } from '../src/main/modules/catalogue/github.js';
const config = loadConfig({
  APP_CORS_ORIGINS: 'http://localhost:5173',
  APP_KEYCLOAK_ISSUER: 'https://identity.example.test/realms/test',
  APP_KEYCLOAK_ADMIN_URL: 'http://identity:8080',
  APP_KEYCLOAK_REALM: 'test',
  APP_KEYCLOAK_ADMIN_CLIENT_SECRET: 'test',
  APP_IDENTITY_ENVIRONMENT: 'staging',
  APP_CATALOGUE_BRANCH: 'main',
});
const source = `permissions:
  identity:
    - name: users:read
      description: Read users
  courses:
    - name: read
realm:
  name: score
  settings:
    registrationAllowed: true
    verifyEmail: true
    internationalizationEnabled: true
    defaultLocale: en
    supportedLocales: [en]
    defaultRole:
      name: member
      composite: true
  clients: [{clientId: account}]
  roles:
    realm:
      - name: admin
        attributes: {owner: [identity]}
        composites:
          realm: [' identity:users:read', 'courses:read']
      - name: user
      - name: administrador
        description: Full administration.
        composites:
          realm: ['identity:users:read', 'courses:read']
      - name: member
  groups:
    - name: staff
      realmRoles: [admin]
      attributes: {department: [support]}
authorizationRegistry:
  enabled: true
  environment: staging
  generation: 1
  revision: ${'c'.repeat(64)}
  permissions: []
  roles: []
  clientTokenScopes:
    - clientId: analytics-web
      enabled: true
      permissions: [identity:users:read]
`;

const base = 'a'.repeat(40);
const revision = 'b'.repeat(40);
const overlay = (enabled = true, version = '0.2.0') =>
  `service: identity-config-sync\nrepo: SCORETech-identity\nnamespace: staging-platform\nversion: ${version}\nenabled: '${enabled}'\nvalueFiles:\n  - environments/identity/identity-config-sync-values.yaml\n`;
const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
function fixture(overlayText = overlay()) {
  const directory = mkdtempSync(join(tmpdir(), 'score-catalogue-'));
  directories.push(directory);
  const activePath = join(directory, 'catalogue.json');
  const statePath = join(directory, 'apply-status.json');
  const catalogue = readCatalogue(source);
  writeFileSync(
    activePath,
    JSON.stringify({
      permissions: catalogue.permissions.map(({ name }) => name),
      roles: catalogue.roles.map(({ name }) => name),
    }),
  );
  const github = {
    head: vi.fn().mockResolvedValue(base),
    file: vi.fn(async (path: string) =>
      path.endsWith('identity-config-sync.yaml') || path.endsWith('identity-account-api.yaml')
        ? path.endsWith('identity-account-api.yaml')
          ? overlayText.replace('service: identity-config-sync', 'service: identity-account-api')
          : overlayText
        : path.endsWith('operations/index.yaml')
          ? '[]'
          : path.includes('/environments/')
            ? '{}'
            : source,
    ),
    commit: vi.fn().mockResolvedValue({ sha: revision, html_url: 'https://example.test/commit' }),
    entries: vi.fn().mockResolvedValue([]),
  };
  return {
    github,
    activePath,
    statePath,
    service: new CatalogueService(
      {
        ...config,
        APP_AUTHORIZATION_CATALOGUE_PATH: activePath,
        APP_CATALOGUE_STATE_PATH: statePath,
      },
      github as unknown as Github,
    ),
  };
}
describe('catalogue invariants', () => {
  it('normalizes legacy whitespace and preserves unrelated realm configuration', () => {
    const catalogue = readCatalogue(source);
    expect(catalogue.roles[0].permissions[0]).toBe('identity:users:read');
    const output = writeCatalogue(catalogue, source);
    expect(output).toContain('clientId: account');
    expect(output).toContain('owner:');
    expect(output).toContain('department:');
    expect(readCatalogue(output)).toEqual({
      ...catalogue,
      permissions: [...catalogue.permissions].sort((a, b) => a.name.localeCompare(b.name)),
    });
  });
  it('materializes aliases before replacing role nodes referenced by registry data', () => {
    const text = source
      .replace('      - name: admin\n', '      - name: &retained admin\n')
      .replace('  permissions: []\n', '  retainedRole: *retained\n  permissions: []\n');
    // A scalar anchor inside the removed role must remain resolvable elsewhere.
    expect(() => parse(writeCatalogue(readCatalogue(text), text))).not.toThrow();
    expect(
      parse(writeCatalogue(readCatalogue(text), text)).authorizationRegistry.retainedRole,
    ).toBe('admin');
  });
  it('preserves registration, verification and locale settings when publishing', () => {
    const catalogue = readCatalogue(source);
    const output = writeCatalogue(catalogue, source);

    expect(output).toMatch(/registrationAllowed: true/);
    expect(output).toMatch(/verifyEmail: true/);
    expect(output).toMatch(/internationalizationEnabled: true/);
    expect(output).toMatch(/defaultLocale: en/);
    expect(parse(output).realm.settings.supportedLocales).toEqual(['en']);
    expect(output).toMatch(/defaultRole:/);
    expect(output).toMatch(/name: member/);
  });
  it('rejects cycles, dangling references and ambiguous names', () => {
    const catalogue = readCatalogue(source);
    expect(() =>
      validateCatalogue({
        ...catalogue,
        roles: [
          { ...catalogue.roles[0], permissions: ['user'] },
          { ...catalogue.roles[1], permissions: ['admin'] },
          ...catalogue.roles.slice(2),
        ],
      }),
    ).toThrow(/cycle/);
    expect(() => validateCatalogue({ ...catalogue, permissions: [] })).toThrow(/does not exist/);
    expect(() =>
      validateCatalogue({ ...catalogue, roles: [...catalogue.roles, catalogue.roles[0]] }),
    ).toThrow(/unique names/);
  });
  it('protects administrator coverage while allowing unrelated role changes', () => {
    const catalogue = readCatalogue(source);
    catalogue.groups = [];
    const next = structuredClone(catalogue);
    next.roles.find((role) => role.name === 'administrador')!.permissions = ['identity:users:read'];
    expect(() => validateCatalogue(next, catalogue)).toThrow(/protected/);
    next.roles.find((role) => role.name === 'administrador')!.permissions = [
      'identity:users:read',
      'courses:read',
    ];
    next.roles[0].permissions = [];
    expect(validateCatalogue(next, catalogue)).toEqual(next);
  });
  it('allows editing non-protected roles', () => {
    const catalogue = readCatalogue(source);
    const next = structuredClone(catalogue);
    next.roles.find((role) => role.name === 'admin')!.permissions = [];
    expect(validateCatalogue(next, catalogue)).toEqual(next);
  });
  it('prevents deleting roles still assigned to groups', () => {
    const catalogue = readCatalogue(source);
    catalogue.groups[0].roles = ['missing'];
    expect(() => validateCatalogue(catalogue)).toThrow(/still references/);
  });
});
describe('additive application permissions', () => {
  it.each(['remove', 'rename', 'description'])(
    'protects existing permission definitions against %s',
    (change) => {
      const previous = readCatalogue(source);
      const next = structuredClone(previous);
      if (change === 'remove') next.permissions.shift();
      else if (change === 'rename') next.permissions[0]!.name = 'sphere:read';
      else next.permissions[0]!.description = 'An unauthorized redefinition';
      expect(() => validateCatalogue(next, previous)).toThrowError(
        expect.objectContaining({ status: 422, code: 'managed_permissions' }),
      );
    },
  );

  it('allows deleting an unused service permission while deriving Admin coverage', () => {
    const previous = readCatalogue(source);
    const next = structuredClone(previous);
    next.permissions = next.permissions.filter((permission) => permission.name !== 'courses:read');
    next.roles = next.roles.map((role) => ({
      ...role,
      permissions: role.permissions.filter((permission) => permission !== 'courses:read'),
    }));
    const validated = validateCatalogue(next, previous);
    expect(validated.roles.find((role) => role.name === 'administrador')!.permissions).toEqual([
      'identity:users:read',
    ]);
    expect(
      readCatalogue(writeCatalogue(validated, source)).permissions.map(
        (permission) => permission.name,
      ),
    ).toEqual(['identity:users:read']);
  });
  it('rejects deleting a service permission still used by a role or access rule', () => {
    const previous = readCatalogue(source);
    const next = structuredClone(previous);
    next.permissions = next.permissions.filter((permission) => permission.name !== 'courses:read');
    expect(() => validateCatalogue(next, previous)).toThrow(/references/);
    next.roles = next.roles.map((role) => ({
      ...role,
      permissions: role.permissions.filter((permission) => permission !== 'courses:read'),
    }));
    next.accessRules = [
      {
        id: 'courses',
        clientId: 'courses-web',
        origin: 'https://courses.example.test',
        requiredPermissions: ['courses:read'],
      },
    ];
    expect(() => validateCatalogue(next, previous)).toThrow(/known atomic/);
  });
  it('checks live application dependencies before deleting a permission, including disabled clients', async () => {
    const previous = readCatalogue(source);
    const next = structuredClone(previous);
    next.permissions = next.permissions.filter((permission) => permission.name !== 'courses:read');
    const fetcher = vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify({
            applications: [
              { name: 'Courses', enabled: false, requiredPermissions: ['courses:read'] },
            ],
          }),
        ),
      );
    const service = new CatalogueService(config, undefined, fetcher);
    await expect(
      service.assertPermissionDeletion(next, previous, 'test-token'),
    ).rejects.toMatchObject({ status: 409, code: 'permission_in_use' });
    fetcher.mockResolvedValue(new Response(JSON.stringify({ applications: [] })));
    await expect(
      service.assertPermissionDeletion(next, previous, 'test-token'),
    ).resolves.toBeUndefined();
    expect(fetcher.mock.calls[0][1].headers.Authorization).toBe('Bearer test-token');
    fetcher.mockResolvedValue(new Response('{}', { status: 503 }));
    await expect(
      service.assertPermissionDeletion(next, previous, 'test-token'),
    ).rejects.toMatchObject({ status: 503 });
    fetcher.mockResolvedValue(new Response('{}'));
    await expect(
      service.assertPermissionDeletion(next, previous, 'test-token'),
    ).rejects.toMatchObject({ status: 502 });
  });

  it('materializes a new application permission and derives protected administrator coverage', () => {
    const previous = readCatalogue(source);
    const input = structuredClone(previous);
    const permission = { name: 'sphere:production:access', description: 'Use SPHERE' };
    input.permissions.push(permission);
    const administrator = input.roles.find((role) => role.name === 'administrador')!;
    expect(administrator.permissions).not.toContain(permission.name);
    const next = validateCatalogue(input, previous);
    expect(next.roles.find((role) => role.name === 'administrador')!.permissions).toEqual(
      next.permissions.map(({ name }) => name),
    );
    const written = writeCatalogue(next, source);
    expect(readCatalogue(written).permissions).toContainEqual(permission);
    expect(parse(written).permissions.sphere).toContainEqual({
      name: 'production:access',
      description: permission.description,
    });
    expect(previous.permissions).not.toContainEqual(permission);
    expect(administrator.permissions).not.toContain(permission.name);
  });

  it('accepts the exact derived administrator composition but rejects changing its description', () => {
    const previous = readCatalogue(source);
    const next = structuredClone(previous);
    next.permissions.push({ name: 'sphere:read', description: '' });
    const administrator = next.roles.find((role) => role.name === 'administrador')!;
    administrator.permissions = next.permissions.map(({ name }) => name).reverse();
    expect(
      validateCatalogue(next, previous).roles.find((role) => role.name === 'administrador')!
        .permissions,
    ).toEqual(next.permissions.map(({ name }) => name));
    administrator.description = 'A redefined protected role';
    expect(() => validateCatalogue(next, previous)).toThrowError(
      expect.objectContaining({ status: 422, code: 'protected_role' }),
    );
  });

  it('still checks administrator coverage when validating an initial complete catalogue', () => {
    const next = readCatalogue(source);
    next.permissions.push({ name: 'sphere:read', description: '' });
    expect(() => validateCatalogue(next)).toThrowError(
      expect.objectContaining({ status: 422, code: 'protected_composition' }),
    );
  });

  it.each([
    'identity',
    'identity-admin-api',
    'admin-web',
    'system',
    'realm-management',
    'keycloak',
  ])('rejects new permissions in reserved %s namespaces', (domain) => {
    const previous = readCatalogue(source);
    expect(() =>
      validateCatalogue(
        {
          ...previous,
          permissions: [...previous.permissions, { name: `${domain}:new-access`, description: '' }],
        },
        previous,
      ),
    ).toThrowError(expect.objectContaining({ status: 422, code: 'reserved_permission' }));
  });
});

describe('application access rules', () => {
  const rule = () => ({
    id: 'sphere-production',
    clientId: 'sphere-web',
    origin: 'https://sphere.score.us.es',
    requiredPermissions: ['courses:read'],
  });
  it('caps each rule at the native provider limit of 1000 permission atoms', () => {
    const permissions = Array.from({ length: 1000 }, (_, index) => `service:operation-${index}`);
    expect(
      AccessRuleSchema.safeParse({ ...rule(), requiredPermissions: permissions }).success,
    ).toBe(true);
    expect(
      AccessRuleSchema.safeParse({
        ...rule(),
        requiredPermissions: [...permissions, 'service:one-more'],
      }).success,
    ).toBe(false);
  });

  it('reads absent rules as empty and round-trips client-bound rules inside the registry', () => {
    const previous = readCatalogue(source);
    expect(previous.accessRules).toEqual([]);
    const next = validateCatalogue({ ...previous, accessRules: [rule()] }, previous);
    const written = writeCatalogue(next, source);
    expect(readCatalogue(written).accessRules).toEqual([rule()]);
    expect(parse(written).authorizationRegistry.accessRules).toEqual([rule()]);
    expect(parse(written).authorizationRegistry.clientTokenScopes).toEqual(
      parse(source).authorizationRegistry.clientTokenScopes,
    );
  });

  it('preserves existing rules for legacy requests and permits an explicit rule removal', () => {
    const previous = validateCatalogue({ ...readCatalogue(source), accessRules: [rule()] });
    const written = writeCatalogue(previous, source);
    const legacy = { ...previous, accessRules: undefined };
    const validated = validateCatalogue(legacy, previous);
    expect(validated.accessRules).toEqual(previous.accessRules);
    expect(readCatalogue(writeCatalogue(legacy, written)).accessRules).toEqual(
      previous.accessRules,
    );
    expect(
      readCatalogue(writeCatalogue({ ...previous, accessRules: [] }, written)).accessRules,
    ).toEqual([]);
    validated.accessRules![0]!.requiredPermissions.push('identity:users:read');
    expect(previous.accessRules![0]!.requiredPermissions).toEqual(['courses:read']);
  });

  it.each([
    'https://sphere.score.us.es',
    'https://sphere.score.us.es:8443',
    'http://localhost:18000',
    'http://127.0.0.1:18000',
  ])('accepts canonical application origin %s', (origin) => {
    expect(() =>
      validateCatalogue({ ...readCatalogue(source), accessRules: [{ ...rule(), origin }] }),
    ).not.toThrow();
  });

  it.each([
    'http://sphere.score.us.es',
    'http://localhost.evil.test:18000',
    'http://127.0.0.1.evil.test:18000',
    'http://127.1:18000',
    'http://[::1]:18000',
    'https://*.score.us.es',
    'https://sphere.score.us.es/',
    'https://sphere.score.us.es/callback',
    'https://sphere.score.us.es?next=evil',
    'https://sphere.score.us.es#fragment',
    'https://user:password@sphere.score.us.es',
    'https://SPHERE.score.us.es',
    'https://sphere.score.us.es:443',
    'https://sphere.score.us.es.',
    ' https://sphere.score.us.es',
    '//sphere.score.us.es',
  ])('rejects noncanonical, insecure or overbroad origin %s', (origin) => {
    expect(() =>
      validateCatalogue({ ...readCatalogue(source), accessRules: [{ ...rule(), origin }] }),
    ).toThrow();
  });

  it.each([
    'identity-admin-web',
    'identity-config-sync',
    'identity-account-service',
    'account',
    'account-console',
    'admin-cli',
    'broker',
    'realm-management',
    'security-admin-console',
    'score-app-11111111-1111-4111-8111-111111111111',
    'SCORE-APP-anything',
  ])('rejects protected identity or native client %s', (clientId) => {
    expect(() =>
      validateCatalogue({ ...readCatalogue(source), accessRules: [{ ...rule(), clientId }] }),
    ).toThrow();
  });

  it.each(['id', 'clientId'])('rejects repeated rule %s', (duplicated) => {
    const second = { ...rule(), id: 'space-production', clientId: 'space-web' };
    if (duplicated === 'id') second.id = rule().id;
    else second.clientId = rule().clientId;
    expect(() =>
      validateCatalogue({ ...readCatalogue(source), accessRules: [rule(), second] }),
    ).toThrowError(expect.objectContaining({ status: 422, code: 'duplicate_access_rule' }));
  });

  it.each([[], ['unknown:permission'], ['user'], ['courses:read', 'courses:read']])(
    'requires nonempty, unique, known atomic permissions (%j)',
    (...requiredPermissions) => {
      expect(() =>
        validateCatalogue({
          ...readCatalogue(source),
          accessRules: [{ ...rule(), requiredPermissions }],
        }),
      ).toThrow();
    },
  );
});

describe('default role', () => {
  it('retains member as the immutable registration baseline, including legacy requests', () => {
    const previous = readCatalogue(source);
    expect(previous.defaultRole).toBe('member');
    const next = validateCatalogue({ ...previous, defaultRole: undefined }, previous);
    const output = parseYaml(writeCatalogue(next, source)) as {
      realm: { settings: { defaultRole: unknown } };
    };
    expect(next.defaultRole).toBe('member');
    expect(output.realm.settings.defaultRole).toEqual({ name: 'member', composite: false });
    expect(validateCatalogue({ ...previous, defaultRole: undefined }).defaultRole).toBe('member');
  });
  it('rejects alternate roles, administrator, nonexistent roles and malformed selections', () => {
    const previous = readCatalogue(source);
    for (const defaultRole of ['user', 'administrador', 'missing', '', ['user', 'member'], null])
      expect(() => validateCatalogue({ ...previous, defaultRole }, previous)).toThrow();
  });
  it('forbids deleting member even when another permission-free default is selected', () => {
    const previous = readCatalogue(source);
    const roles = previous.roles.filter((role) => role.name !== 'member');
    expect(() => validateCatalogue({ ...previous, roles }, previous)).toThrow(/default role/);
    expect(() =>
      validateCatalogue({ ...previous, defaultRole: undefined, roles }, previous),
    ).toThrow(/default role/);
    expect(() => validateCatalogue({ ...previous, roles, defaultRole: 'user' }, previous)).toThrow(
      /default role/,
    );
    expect(() => writeCatalogue({ ...previous, roles }, source)).toThrow(/default role/);
  });
  it('blocks changing the default before granting member service access', () => {
    const previous = readCatalogue(source);
    const next = structuredClone(previous);
    next.defaultRole = 'user';
    next.roles.find((role) => role.name === 'member')!.permissions = ['courses:read'];
    expect(() => validateCatalogue(next, previous)).toThrow(
      expect.objectContaining({ status: 422, code: 'immutable_default_role' }),
    );
    expect(() => writeCatalogue(next, source)).toThrow(
      expect.objectContaining({ status: 422, code: 'immutable_default_role' }),
    );
  });
  it.each(['direct', 'transitive'])(
    'always keeps member permission-free (%s composition)',
    (composition) => {
      const previous = readCatalogue(source);
      const next = structuredClone(previous);
      delete next.defaultRole;
      next.roles.find((role) => role.name === 'member')!.permissions = [
        composition === 'direct' ? 'courses:read' : 'user',
      ];
      next.roles.find((role) => role.name === 'user')!.permissions = ['courses:read'];
      expect(() => validateCatalogue(next)).toThrow(
        expect.objectContaining({ status: 422, code: 'privileged_default_role' }),
      );
    },
  );
  it.each(['member', 'user'])('rejects preserved native client grants through %s', (nativeRole) => {
    const data = parseYaml(source) as {
      realm: {
        roles: {
          realm: { name: string; composites?: { client?: Record<string, string[]> } }[];
        };
      };
    };
    data.realm.roles.realm.find((role) => role.name === nativeRole)!.composites = {
      client: { 'realm-management': ['manage-users'] },
    };
    const nativeSource = dumpYaml(data);
    const catalogue = readCatalogue(nativeSource);
    if (nativeRole !== 'member')
      catalogue.roles.find((role) => role.name === 'member')!.permissions = [nativeRole];
    expect(() => validateCatalogue(catalogue)).not.toThrow();
    expect(() => writeCatalogue(catalogue, nativeSource)).toThrow(
      expect.objectContaining({ status: 422, code: 'privileged_default_role' }),
    );
  });
});
describe('Git publication boundary', () => {
  it('keeps legal versions and other ambiguous strings compatible with YAML 1.1 readers', () => {
    const data = { version: '2026-10-23', createdAt: '2026-11-03T04:00:00.000Z', value: 'yes' };
    expect(parse(dumpYaml(data), { schema: 'yaml-1.1' })).toEqual(data);
  });
  it('retains active client token filters when publishing role changes', async () => {
    const { service, github } = fixture();
    const catalogue = readCatalogue(source);
    catalogue.roles.find((role) => role.name === 'user')!.permissions = ['courses:read'];
    await service.publish(base, catalogue, 'Change role while preserving token scopes', 'actor');
    const files = github.commit.mock.calls[0][1] as { path: string; content: string }[];
    const snapshot = files.find((file) => file.path.includes('/revisions/staging/'))!;
    const before = parseYaml(source) as { authorizationRegistry: { clientTokenScopes: unknown } };
    const after = parseYaml(snapshot.content) as {
      authorizationRegistry: { clientTokenScopes: unknown };
    };
    expect(after.authorizationRegistry.clientTokenScopes).toEqual(
      before.authorizationRegistry.clientTokenScopes,
    );
  });
  it('rejects changing the registration baseline before writing Git', async () => {
    const { service, github } = fixture();
    const catalogue = readCatalogue(source);
    await expect(
      service.publish(
        base,
        { ...catalogue, defaultRole: 'user' },
        'Change the registration default role',
        'actor',
      ),
    ).rejects.toMatchObject({ status: 422, code: 'immutable_default_role' });
    expect(github.commit).not.toHaveBeenCalled();
  });
  it('preserves the member baseline in every target for an old client omitting the field', async () => {
    const { service, github } = fixture();
    const prodPath = `environments/identity/generated/revisions/production/${'d'.repeat(64)}.yaml`;
    const original = github.file.getMockImplementation()!;
    github.file.mockImplementation(async (path: string) => {
      if (path === prodPath) return source;
      const text = await original(path);
      return path.startsWith('environments/production/')
        ? text.replace('environments/identity/identity-config-sync-values.yaml', prodPath)
        : text;
    });
    const legacy = readCatalogue(source);
    delete legacy.defaultRole;
    await service.publish(base, legacy, 'Legacy catalogue client', 'actor', [
      'staging',
      'production',
    ]);
    const files = github.commit.mock.calls[0][1] as { path: string; content: string }[];
    expect(
      readCatalogue(files.find((f) => f.path.includes('/revisions/staging/'))!.content).defaultRole,
    ).toBe('member');
    expect(
      readCatalogue(files.find((f) => f.path.includes('/revisions/production/'))!.content)
        .defaultRole,
    ).toBe('member');
  });
  it('rejects a default administrator before writing Git', async () => {
    const { service, github } = fixture();
    await expect(
      service.publish(
        base,
        { ...readCatalogue(source), defaultRole: 'administrador' },
        'Invalid catalogue request',
        'actor',
      ),
    ).rejects.toMatchObject({ status: 422, code: 'protected_default_role' });
    expect(github.commit).not.toHaveBeenCalled();
  });
  it('reads immutable operation history', async () => {
    const { service } = fixture();
    await expect(service.revisions()).resolves.toEqual([]);
  });
  it('publishes immutable snapshots and paired environment references directly', async () => {
    const { service, github } = fixture();
    await service.publish(base, readCatalogue(source), 'Review catalogue permissions', 'actor', [
      'staging',
      'production',
    ]);
    const files = github.commit.mock.calls[0][1] as { path: string; content: string }[];
    for (const env of ['staging', 'production']) {
      const snapshot = files.find((file) =>
        new RegExp(`revisions/${env}/[a-f0-9]{64}\\.yaml$`).test(file.path),
      )!;
      expect(snapshot).toBeDefined();
      expect(
        files.find((file) => file.path === `environments/${env}/identity-config-sync.yaml`)!
          .content,
      ).toContain(snapshot.path);
      expect(
        files.find((file) => file.path === `environments/${env}/identity-account-api.yaml`)!
          .content,
      ).toContain(snapshot.path);
      const normalize = (roles: ReturnType<typeof readCatalogue>['roles']) =>
        roles.map((role) => ({ ...role, permissions: [...role.permissions].sort() }));
      expect(normalize(readCatalogue(snapshot.content).roles)).toEqual(
        normalize(readCatalogue(source).roles),
      );
    }
    expect(
      files.some((file) => file.path === 'environments/identity/generated/operations/index.yaml'),
    ).toBe(true);
  });
  it.each([false, true])('blocks disabled or unmigrated registries (%s)', async (enabled) => {
    const { service, github } = fixture(overlay(enabled));
    if (enabled) {
      const data = parseYaml(source) as Record<string, unknown>;
      data.authorizationRegistry = { enabled: false };
      const original = github.file.getMockImplementation()!;
      github.file.mockImplementation(async (path: string) =>
        path === 'environments/identity/identity-config-sync-values.yaml'
          ? dumpYaml(data)
          : original(path),
      );
    }
    await expect(
      service.publish(base, readCatalogue(source), 'Review catalogue permissions', 'actor'),
    ).rejects.toMatchObject({ status: 409 });
    expect(github.commit).not.toHaveBeenCalled();
  });
  it('checks optimistic concurrency before any Git write', async () => {
    const github = new Github(config);
    const request = vi.spyOn(github, 'request').mockResolvedValue({ object: { sha: revision } });
    await expect(
      github.commit(
        base,
        [{ path: 'environments/staging/identity-config-sync.yaml', content: 'enabled: true\n' }],
        'Title',
      ),
    ).rejects.toMatchObject({ status: 409 });
    expect(request).toHaveBeenCalledTimes(1);
  });
  it('restores historical roles while retaining current service permissions and contracts', async () => {
    const { service, github } = fixture();
    const catalogue = readCatalogue(source);
    catalogue.roles.find((role) => role.name === 'admin')!.permissions = [];
    const operation = await service.publish(base, catalogue, 'Save catalogue history', 'actor');
    const files = github.commit.mock.calls[0][1] as { path: string; content: string }[];
    const stored = new Map(files.map((file) => [file.path, file.content]));
    const snapshotPath = `environments/identity/generated/revisions/staging/${operation.revisions.staging}.yaml`;
    const data = parseYaml(stored.get(snapshotPath)!) as Record<string, unknown>;
    const latest = readCatalogue(stored.get(snapshotPath)!);
    latest.defaultRole = 'member';
    latest.permissions.push({ name: 'new:permission', description: '' });
    latest.roles.find((role) => role.name === 'administrador')!.permissions.push('new:permission');
    latest.roles.find((role) => role.name === 'admin')!.permissions = ['new:permission'];
    const current = parseYaml(writeCatalogue(latest, dumpYaml(data))) as Record<string, unknown>;
    current.identityContracts = { fixture: { version: '2.0.0' } };
    const activeScopes = [
      { clientId: 'analytics-web', enabled: true, permissions: ['courses:read'] },
    ];
    (current.authorizationRegistry as Record<string, unknown>).clientTokenScopes = activeScopes;
    const currentPath = `environments/identity/generated/revisions/staging/${'c'.repeat(64)}.yaml`;
    stored.set(currentPath, dumpYaml(current));
    for (const name of ['identity-config-sync', 'identity-account-api']) {
      const path = `environments/staging/${name}.yaml`;
      stored.set(path, stored.get(path)!.replace(snapshotPath, currentPath));
    }
    const original = github.file.getMockImplementation()!;
    github.file.mockImplementation(async (path: string) => stored.get(path) ?? original(path));
    const result = await service.rollback(
      base,
      operation.id,
      ['staging'],
      'Restore catalogue history',
      'actor',
    );
    expect(result.type).toBe('rollback');
    const mutations = github.commit.mock.calls[1][1] as { path: string; content: string }[];
    expect(
      readCatalogue(mutations.find((file) => file.path.includes('/revisions/staging/'))!.content)
        .defaultRole,
    ).toBe('member');
    const restored = mutations.find((file) => file.path.includes('/generated/revisions/staging/'))!;
    const roles = readCatalogue(restored.content).roles;
    expect(roles.find((role) => role.name === 'admin')!.permissions).toEqual([]);
    expect(roles.find((role) => role.name === 'administrador')!.permissions).toContain(
      'new:permission',
    );
    expect((parseYaml(restored.content) as Record<string, unknown>).identityContracts).toEqual({
      fixture: { version: '2.0.0' },
    });
    expect(
      (parseYaml(restored.content) as { authorizationRegistry: { clientTokenScopes: unknown } })
        .authorizationRegistry.clientTokenScopes,
    ).toEqual(activeScopes);
    expect(mutations.some((file) => file.path === snapshotPath)).toBe(false);
  });
  it('reads immutable comparison snapshots and rejects changed content or another environment', async () => {
    const { service, github } = fixture();
    const operation = await service.publish(
      base,
      readCatalogue(source),
      'Save catalogue for comparison',
      'actor',
    );
    const files = github.commit.mock.calls[0][1] as { path: string; content: string }[];
    const stored = files.find((file) => file.path.includes('/generated/revisions/staging/'))!;
    const original = github.file.getMockImplementation()!;
    github.file.mockImplementation(async (path: string) =>
      path.includes('/generated/revisions/') ? stored.content : original(path),
    );
    await expect(service.snapshot('staging', operation.revisions.staging!)).resolves.toHaveProperty(
      'catalogue.roles',
    );
    await expect(
      service.snapshot('production', operation.revisions.staging!),
    ).rejects.toMatchObject({ status: 409, code: 'invalid_snapshot' });
    const changed = parseYaml(stored.content) as Record<string, unknown>;
    changed.displayName = 'Changed after publication';
    stored.content = dumpYaml(changed);
    await expect(service.snapshot('staging', operation.revisions.staging!)).rejects.toMatchObject({
      status: 409,
      code: 'changed_snapshot',
    });
  });
  it('reads assignment roles only from the active projection for its configured environment', async () => {
    const { service, github, activePath } = fixture();
    github.head.mockRejectedValue(new Error('Git is unavailable'));
    writeFileSync(activePath, JSON.stringify({ permissions: [], roles: ['member'] }));
    await expect(service.assignmentRoles('staging')).resolves.toEqual(['member']);
    writeFileSync(activePath, JSON.stringify({ permissions: [], roles: ['member', 'user'] }));
    await expect(service.assignmentRoles('staging')).resolves.toEqual(['member', 'user']);
    await expect(service.assignmentRoles('production')).rejects.toMatchObject({
      status: 403,
      code: 'environment_not_allowed',
    });
    expect(github.head).not.toHaveBeenCalled();
    expect(github.file).not.toHaveBeenCalled();
  });
  it('does not fall back to desired Git roles when the active projection is missing', async () => {
    const { service, github, activePath } = fixture();
    rmSync(activePath);
    await expect(service.assignmentRoles('staging')).rejects.toThrow();
    expect(github.head).not.toHaveBeenCalled();
    expect(github.file).not.toHaveBeenCalled();
  });
  it('reuses an immutable parsed snapshot but checks HEAD and isolates editor changes', async () => {
    const { service, github } = fixture();
    const first = await service.current('staging');
    first.catalogue.roles.length = 0;
    expect((await service.current('staging')).catalogue.roles.map(({ name }) => name)).toContain(
      'user',
    );
    expect(github.head).toHaveBeenCalledTimes(2);
    expect(github.file).toHaveBeenCalledTimes(2);
    github.head.mockResolvedValue(revision);
    const original = github.file.getMockImplementation()!;
    github.file.mockImplementation(async (path) =>
      (await original(path)).replace('      - name: user\n', ''),
    );
    expect(
      (await service.current('staging')).catalogue.roles.map(({ name }) => name),
    ).not.toContain('user');
    expect(github.file).toHaveBeenCalledTimes(4);
  });
  it('coalesces concurrent catalogue reads and never serves cached roles on HEAD failure', async () => {
    const { service, github } = fixture();
    await Promise.all(Array.from({ length: 12 }, () => service.current('staging')));
    expect(github.head).toHaveBeenCalledTimes(1);
    expect(github.file).toHaveBeenCalledTimes(2);
    github.head.mockRejectedValueOnce(new Error('HEAD unavailable'));
    await expect(service.current('staging')).rejects.toThrow('HEAD unavailable');
  });
  it('retries failed snapshots and keeps environments separate at the same SHA', async () => {
    const { service, github } = fixture();
    github.file.mockRejectedValueOnce(new Error('Snapshot unavailable'));
    await expect(service.current('staging')).rejects.toThrow('Snapshot unavailable');
    expect((await service.current('staging')).catalogue.roles.map(({ name }) => name)).toContain(
      'user',
    );
    expect((await service.current('production')).catalogue.roles.map(({ name }) => name)).toContain(
      'user',
    );
    expect(github.file).toHaveBeenCalledTimes(5);
  });
});

describe('file-backed catalogue application status', () => {
  const desiredRevision = 'c'.repeat(64);
  const previousRevision = 'd'.repeat(64);

  it('keeps a saved Git revision pending until the provider application is reported', async () => {
    const { service } = fixture();
    await expect(service.status('staging')).resolves.toMatchObject({
      environment: 'staging',
      desiredRevision,
      observedRevision: null,
      generation: null,
      state: 'pending',
    });
  });

  it('marks a revision applied only after the observed revision matches', async () => {
    const { service, statePath } = fixture();
    writeFileSync(
      statePath,
      JSON.stringify({
        observedRevision: desiredRevision,
        generation: 2,
        state: 'applied',
      }),
    );
    await expect(service.status('staging')).resolves.toMatchObject({
      desiredRevision,
      observedRevision: desiredRevision,
      generation: 2,
      state: 'applied',
      detail: expect.stringContaining('verified in the identity provider'),
    });
  });

  it('does not mistake the previous applied revision for the current desired revision', async () => {
    const { service, statePath } = fixture();
    writeFileSync(
      statePath,
      JSON.stringify({
        observedRevision: previousRevision,
        generation: 1,
        state: 'applied',
      }),
    );
    await expect(service.status('staging')).resolves.toMatchObject({
      desiredRevision,
      observedRevision: previousRevision,
      state: 'pending',
    });
  });

  it('reports a failed application while keeping assignments on the previous active projection', async () => {
    const { service, activePath, statePath } = fixture();
    writeFileSync(activePath, JSON.stringify({ permissions: [], roles: ['member'] }));
    writeFileSync(
      statePath,
      JSON.stringify({
        observedRevision: previousRevision,
        generation: 1,
        state: 'failed',
        detail: 'Provider reconciliation failed.',
      }),
    );
    await expect(service.status('staging')).resolves.toMatchObject({
      desiredRevision,
      observedRevision: previousRevision,
      state: 'failed',
      detail: 'Provider reconciliation failed.',
    });
    await expect(service.assignmentRoles('staging')).resolves.toEqual(['member']);
  });

  it('reports an in-progress application without declaring it applied', async () => {
    const { service, statePath } = fixture();
    writeFileSync(
      statePath,
      JSON.stringify({
        observedRevision: previousRevision,
        state: 'applying',
      }),
    );
    await expect(service.status('staging')).resolves.toMatchObject({
      desiredRevision,
      observedRevision: previousRevision,
      state: 'applying',
    });
  });

  it('treats an unreadable status document as unconfirmed application', async () => {
    const { service, statePath } = fixture();
    writeFileSync(statePath, 'incomplete JSON');
    await expect(service.status('staging')).resolves.toMatchObject({
      desiredRevision,
      observedRevision: null,
      state: 'pending',
    });
  });

  it('rejects another environment before reading its desired catalogue', async () => {
    const { service, github } = fixture();
    await expect(service.status('production')).rejects.toMatchObject({
      status: 403,
      code: 'environment_not_allowed',
    });
    expect(github.head).not.toHaveBeenCalled();
  });
});

describe('administrative catalogue access', () => {
  it('allows service access and role management grants through ordinary catalogue roles', () => {
    const catalogue = readCatalogue(source);
    catalogue.permissions.push(
      { name: 'admin-web:production:access', description: '' },
      { name: 'identity:roles:manage', description: '' },
    );
    catalogue.roles
      .find((role) => role.name === 'administrador')!
      .permissions.push('admin-web:production:access', 'identity:roles:manage');
    expect(() => validateCatalogue(catalogue)).not.toThrow();
    catalogue.roles
      .find((role) => role.name === 'user')!
      .permissions.push('admin-web:production:access', 'identity:roles:manage');
    expect(() => validateCatalogue(catalogue)).not.toThrow();
    catalogue.roles.find((role) => role.name === 'user')!.permissions = ['administrador'];
    expect(() => validateCatalogue(catalogue)).toThrow(/protected administrator/);
  });
});
