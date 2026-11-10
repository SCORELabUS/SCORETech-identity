import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { once } from 'node:events';
import type { Server } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Principal, IdentityAdminClient } from '@scoretech/identity-internal';
import {
  assertRoleDelegation,
  createIdentityRouter,
} from '../src/main/modules/identity/identity.routes.js';
import {
  validateCatalogue,
  writeCatalogue,
} from '../src/main/modules/catalogue/catalogue-model.js';
import { loadConfig } from '../src/main/config/app-config.js';
import { errorHandler } from '../src/main/shared/http/errors.js';
import { stringify } from 'yaml';

const entry = 'admin-web:local:access';
const assign = 'identity:users:update:roles';
const view = 'identity:users:view';
const remove = 'identity:users:delete';
const create = 'identity:users:create';
const allPermissions = [entry, assign, view, remove, create];
type Registry = Parameters<typeof assertRoleDelegation>[2];
const registry = (): Registry => ({
  environment: 'local',
  generation: 1,
  revision: 'a'.repeat(64),
  permissions: allPermissions.map((name) => ({ name })),
  roles: [
    { name: 'administrador', permissions: [...allPermissions] },
    { name: 'member', permissions: [] },
    { name: 'reader', permissions: [view] },
    { name: 'nested-reader', permissions: ['reader'] },
    { name: 'operator', permissions: [remove] },
  ],
});
const actor = (overrides: Partial<Principal> = {}): Principal => ({
  subject: '11111111-1111-4111-8111-111111111111',
  roles: [entry, assign, view],
  effectiveRoleNames: [entry, assign, view],
  ...overrides,
});
const liveAdministrator = (): Principal =>
  actor({
    roles: [entry, assign],
    effectiveRoleNames: [entry, assign, 'administrador'],
  });
const applicationPermission = 'sphere:admin';
const expandedRegistry = (): Registry => {
  const active = registry();
  active.permissions.push({ name: applicationPermission });
  active.roles
    .find((role) => role.name === 'administrador')!
    .permissions.push(applicationPermission);
  active.roles.push(
    { name: 'sphere-operator', permissions: [applicationPermission] },
    { name: 'nested-sphere-operator', permissions: ['sphere-operator'] },
  );
  return active;
};

describe('SCORE role delegation boundary', () => {
  it('allows permission-free membership and transitive grants held in both permission sets', () => {
    expect(() =>
      assertRoleDelegation(actor(), ['member', 'nested-reader'], registry()),
    ).not.toThrow();
  });

  it('rejects a newly granted live permission until it is present in a fresh signed token', () => {
    const current = actor({ effectiveRoleNames: [...allPermissions] });
    expect(() => assertRoleDelegation(current, ['operator'], registry())).toThrowError(
      expect.objectContaining({ status: 403, code: 'role_delegation_forbidden' }),
    );
    expect(() =>
      assertRoleDelegation({ ...current, roles: [...allPermissions] }, ['operator'], registry()),
    ).not.toThrow();
  });

  it('rejects revoked live authority even while the old signed token still has it', () => {
    expect(() =>
      assertRoleDelegation(
        actor({ effectiveRoleNames: [entry, assign] }),
        ['nested-reader'],
        registry(),
      ),
    ).toThrowError(expect.objectContaining({ status: 403, code: 'role_delegation_forbidden' }));
  });

  it('requires live assignment authority even when the requested role grants no access', () => {
    for (const effectiveRoleNames of [undefined, [entry], [assign]]) {
      expect(() =>
        assertRoleDelegation(actor({ effectiveRoleNames }), ['member'], registry()),
      ).toThrowError(expect.objectContaining({ status: 403 }));
    }
  });

  it('rejects a permission from another environment', () => {
    expect(() =>
      assertRoleDelegation(actor(), ['member'], { ...registry(), environment: 'production' }),
    ).toThrowError(expect.objectContaining({ status: 403 }));
  });

  it('does not allow a delegated operator to grant the protected administrator role', () => {
    expect(() =>
      assertRoleDelegation(
        actor({ roles: allPermissions, effectiveRoleNames: allPermissions }),
        ['administrador'],
        registry(),
      ),
    ).toThrowError(expect.objectContaining({ status: 403, code: 'protected_role' }));
  });

  it('allows current protected membership to delegate administrator without every signed atomic grant', () => {
    const administrator = actor({
      roles: allPermissions,
      effectiveRoleNames: [...allPermissions, 'administrador'],
    });
    expect(() => assertRoleDelegation(administrator, ['administrador'], registry())).not.toThrow();
    expect(() =>
      assertRoleDelegation(
        { ...administrator, roles: [entry, assign, 'administrador'] },
        ['administrador'],
        registry(),
      ),
    ).not.toThrow();
  });

  it('allows a current full administrator to assign newly expanded roles missing from the old token', () => {
    const administrator = liveAdministrator();
    const active = expandedRegistry();
    expect(administrator.roles).not.toContain(applicationPermission);
    expect(administrator.effectiveRoleNames).not.toContain(applicationPermission);
    expect(() =>
      assertRoleDelegation(administrator, ['nested-sphere-operator'], active),
    ).not.toThrow();
    expect(() => assertRoleDelegation(administrator, ['administrador'], active)).not.toThrow();
  });

  it('still requires both signed and current service-entry and role-assignment authority for a full administrator', () => {
    const administrator = liveAdministrator();
    for (const overrides of [
      { roles: [entry, 'administrador'] },
      { roles: [assign, 'administrador'] },
      { effectiveRoleNames: [entry, 'administrador'] },
      { effectiveRoleNames: [assign, 'administrador'] },
    ])
      expect(() =>
        assertRoleDelegation(
          { ...administrator, ...overrides },
          ['nested-sphere-operator'],
          expandedRegistry(),
        ),
      ).toThrowError(expect.objectContaining({ status: 403, code: 'role_delegation_forbidden' }));
  });

  it.each(['neither', 'signed-only', 'live-only'])(
    'keeps delegated operators bounded for newly declared role permissions (%s)',
    (proof) => {
      const delegated = actor();
      if (proof === 'signed-only') delegated.roles.push(applicationPermission);
      if (proof === 'live-only') delegated.effectiveRoleNames!.push(applicationPermission);
      expect(() =>
        assertRoleDelegation(delegated, ['nested-sphere-operator'], expandedRegistry()),
      ).toThrowError(expect.objectContaining({ status: 403, code: 'role_delegation_forbidden' }));
    },
  );

  it('permits a delegated operator only when the new atom is in both signed and live grants', () => {
    const delegated = actor();
    delegated.roles.push(applicationPermission);
    delegated.effectiveRoleNames!.push(applicationPermission);
    expect(() =>
      assertRoleDelegation(delegated, ['nested-sphere-operator'], expandedRegistry()),
    ).not.toThrow();
  });

  it('does not preserve full-administrator delegation after live protected membership is revoked', () => {
    const formerAdministrator = actor({ roles: [entry, assign, 'administrador'] });
    expect(() =>
      assertRoleDelegation(formerAdministrator, ['nested-sphere-operator'], expandedRegistry()),
    ).toThrowError(expect.objectContaining({ status: 403, code: 'role_delegation_forbidden' }));
  });

  it('rejects unknown roles, direct atomic permissions and dangling transitive references', () => {
    for (const requester of [actor(), liveAdministrator()]) {
      for (const role of ['unknown', view]) {
        expect(() => assertRoleDelegation(requester, [role], registry())).toThrowError(
          expect.objectContaining({ status: 400, code: 'invalid_role' }),
        );
      }
      const active = registry();
      active.roles.push({ name: 'broken', permissions: ['missing-child'] });
      expect(() => assertRoleDelegation(requester, ['broken'], active)).toThrowError(
        expect.objectContaining({ status: 400, code: 'invalid_role' }),
      );
    }
  });

  it('fails closed on a cyclic role graph', () => {
    const active = registry();
    active.roles.push(
      { name: 'first', permissions: ['second'] },
      { name: 'second', permissions: ['first'] },
    );
    for (const requester of [actor(), liveAdministrator()])
      expect(() => assertRoleDelegation(requester, ['first'], active)).toThrowError(
        expect.objectContaining({ status: 503, code: 'invalid_catalogue' }),
      );
  });
});

const publicCatalogue = () => ({
  defaultRole: 'member',
  permissions: registry().permissions.map((permission) => ({ ...permission, description: '' })),
  roles: registry().roles.map((role) => ({ ...role, description: '' })),
  groups: [],
});

describe('public membership never grants service access', () => {
  it('accepts a permission-free default member and rejects direct or inherited access', () => {
    expect(() => validateCatalogue(publicCatalogue())).not.toThrow();
    for (const permissions of [[view], ['nested-reader']]) {
      const catalogue = publicCatalogue();
      catalogue.roles.find((role) => role.name === 'member')!.permissions = permissions;
      expect(() => validateCatalogue(catalogue)).toThrowError(
        expect.objectContaining({ status: 422, code: 'privileged_default_role' }),
      );
    }
  });

  it('rejects hidden Keycloak client-role grants preserved from the source profile', () => {
    const catalogue = publicCatalogue();
    const source = stringify({
      permissions: {},
      realm: {
        name: 'score',
        settings: { defaultRole: { name: 'member' } },
        roles: {
          realm: catalogue.roles.map((role) => ({
            name: role.name,
            composites: {
              realm: role.permissions,
              ...(role.name === 'member'
                ? { client: { 'realm-management': ['manage-users'] } }
                : {}),
            },
          })),
        },
        groups: [],
      },
    });
    expect(() => writeCatalogue(catalogue, source)).toThrowError(
      expect.objectContaining({ status: 422, code: 'privileged_default_role' }),
    );
  });
});

const servers: Server[] = [];
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

it('refuses an administrative user creation before writing when member has gained privileges', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'score-member-guard-'));
  directories.push(directory);
  const active = registry();
  active.roles.find((role) => role.name === 'member')!.permissions = [entry];
  await writeFile(join(directory, 'active-registry.json'), JSON.stringify(active));
  const config = loadConfig({
    APP_CORS_ORIGINS: 'http://localhost:18000',
    APP_KEYCLOAK_ISSUER: 'https://identity.example.test/identity/auth/realms/score',
    APP_KEYCLOAK_ADMIN_URL: 'http://identity:8080/identity/auth',
    APP_KEYCLOAK_REALM: 'score',
    APP_KEYCLOAK_ADMIN_CLIENT_SECRET: 'fixture-only',
    APP_AUTHORIZATION_CATALOGUE_PATH: join(directory, 'catalogue.json'),
    APP_IDENTITY_ENVIRONMENT: 'local',
  });
  const client = { createUser: vi.fn(), replaceManagedRealmRoles: vi.fn() };
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const app = express();
  app.use(express.json());
  app.use((_request, response, next) => {
    response.locals.principal = actor({ roles: [...allPermissions] });
    response.locals.identityEnvironment = 'local';
    next();
  });
  app.use(createIdentityRouter(client as unknown as IdentityAdminClient, logger, config));
  app.use(errorHandler);
  const server = app.listen(0, '127.0.0.1');
  servers.push(server);
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing test server port.');
  const response = await fetch(`http://127.0.0.1:${address.port}/users`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'new-member', email: 'member@example.test' }),
  });
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ error: { code: 'privileged_member_role' } });
  expect(client.createUser).not.toHaveBeenCalled();
  expect(client.replaceManagedRealmRoles).not.toHaveBeenCalled();
});
