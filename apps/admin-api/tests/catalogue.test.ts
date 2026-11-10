import { describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import { loadConfig } from '../src/main/config/app-config.js';
import {
  readCatalogue,
  validateCatalogue,
  writeCatalogue,
  AccessRuleSchema,
  dumpYaml,
  parseYaml,
} from '../src/main/modules/catalogue/catalogue-model.js';
import { CatalogueService } from '../src/main/modules/catalogue/catalogue-service.js';
const config = loadConfig({
  APP_CORS_ORIGINS: 'http://localhost:5173',
  APP_KEYCLOAK_ISSUER: 'https://identity.example.test/realms/test',
  APP_KEYCLOAK_ADMIN_URL: 'http://identity:8080',
  APP_KEYCLOAK_REALM: 'test',
  APP_KEYCLOAK_ADMIN_CLIENT_SECRET: 'test',
  APP_IDENTITY_ENVIRONMENT: 'staging',
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
    const fetcher = vi.fn().mockResolvedValue(
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
