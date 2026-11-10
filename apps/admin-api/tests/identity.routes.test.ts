import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createIdentityRouter } from '../src/main/modules/identity/identity.routes.js';
import { errorHandler } from '../src/main/shared/http/errors.js';
import { loadConfig } from '../src/main/config/app-config.js';
import type { Principal } from '@scoretech/identity-internal';
import { validateCatalogue } from '../src/main/modules/catalogue/catalogue-model.js';

const actor = '11111111-1111-4111-8111-111111111111';
const target = '22222222-2222-4222-8222-222222222222';
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
  vi.clearAllMocks();
});
export const config = loadConfig({
  APP_CORS_ORIGINS: 'http://localhost:18000',
  APP_KEYCLOAK_ISSUER: 'https://identity.example.test/identity/auth/realms/score',
  APP_KEYCLOAK_ADMIN_URL: 'http://identity:8080/identity/auth',
  APP_KEYCLOAK_REALM: 'score',
  APP_KEYCLOAK_ADMIN_CLIENT_SECRET: 'test-secret',
  APP_ACCOUNT_PUBLIC_URL: 'http://localhost:18000/identity/account/',
  APP_IDENTITY_ENVIRONMENT: 'local',
  APP_REQUIRE_ADMIN_PASSKEY: 'false',
});
const entry = 'admin-web:local:access';
const defaultPermissions = [
  entry,
  'identity:users:view',
  'identity:users:create',
  'identity:users:update:name',
  'identity:users:update:email',
  'identity:users:activate',
  'identity:users:deactivate',
  'identity:users:delete',
  'identity:users:credentials:view',
  'identity:users:credentials:delete',
  'identity:users:update:roles',
  'identity:users:send-verification',
  'identity:users:logout',
  'identity:roles:view',
];
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
const makeClient = () => ({
  listUsers: vi.fn().mockResolvedValue([]),
  getUser: vi.fn().mockResolvedValue({
    id: actor,
    email: 'test@example.test',
    emailVerified: true,
    enabled: true,
    attributes: { private: ['hidden'], tentuAvatar: ['forest'] },
  }),
  createUser: vi.fn().mockResolvedValue(target),
  updateUser: vi.fn().mockResolvedValue(undefined),
  executeActionsEmail: vi.fn().mockResolvedValue(undefined),
  logoutUser: vi.fn().mockResolvedValue(undefined),
  logoutSession: vi.fn().mockResolvedValue(undefined),
  listRealmRoles: vi.fn().mockResolvedValue([]),
  getUserRealmRoles: vi.fn().mockResolvedValue([]),
  getUserRealmEffectiveRoles: vi.fn().mockResolvedValue([]),
  replaceManagedRealmRoles: vi.fn().mockResolvedValue(undefined),
  deleteUser: vi.fn().mockResolvedValue(undefined),
  setPassword: vi.fn().mockResolvedValue(undefined),
  listSessions: vi
    .fn()
    .mockImplementation(async (id: string) => (id === actor ? [{ id: 'actor-session' }] : [])),
  listCredentials: vi.fn().mockResolvedValue([]),
  deleteCredential: vi.fn().mockResolvedValue(undefined),
  reserveVerification: vi.fn().mockResolvedValue(undefined),
  prepareRecovery: vi.fn().mockResolvedValue({
    id: target,
    caseReference: 'SOP-FIXTURE',
    expiresAt: Date.now() + 1800000,
  }),
  recoveryStatus: vi.fn().mockResolvedValue({ recovery: null }),
  createRecovery: vi.fn().mockResolvedValue({
    id: target,
    caseReference: 'SOP-FIXTURE',
    url: 'http://localhost:18000/identity/auth/realms/score/tentu-recovery#fixture',
    expiresAt: Date.now() + 600000,
    state: 'issued',
  }),
  revokeRecovery: vi.fn().mockResolvedValue(undefined),
  listSecurityEvents: vi.fn().mockResolvedValue({ enabled: true, events: [], first: 0, max: 50 }),
});
async function setup(permissions?: string[], assurance: Partial<Principal> = {}) {
  const client = makeClient();
  const signedRoles = permissions ?? ['administrador', ...defaultPermissions];
  const currentRoles = assurance.effectiveRoleNames ?? signedRoles;
  client.getUser.mockImplementation(async (id: string) => ({
    id,
    email: 'test@example.test',
    emailVerified: true,
    enabled: true,
    attributes: { private: ['hidden'], tentuAvatar: ['forest'] },
  }));
  client.getUserRealmEffectiveRoles.mockImplementation(async (id: string) =>
    (id === actor ? currentRoles : []).map((name) => ({ id: name, name })),
  );
  const catalogue = validateCatalogue({
    defaultRole: 'member',
    permissions: defaultPermissions.map((name) => ({ name, description: name })),
    roles: [
      {
        name: 'administrador',
        description: 'Identity administrator',
        permissions: defaultPermissions,
      },
      { name: 'member', description: 'SCORE member', permissions: [] },
      {
        name: 'reader',
        description: 'User directory reader',
        permissions: ['identity:users:view'],
      },
    ],
    groups: [],
  });
  client.listRealmRoles.mockResolvedValue(
    catalogue.roles.map((role) => ({
      id: role.name,
      name: role.name,
      description: role.description,
    })),
  );
  const directory = await mkdtemp(join(tmpdir(), 'score-identity-routes-'));
  directories.push(directory);
  const cataloguePath = join(directory, 'catalogue.json');
  await writeFile(
    cataloguePath,
    JSON.stringify({
      permissions: catalogue.permissions.map((permission) => permission.name),
      roles: catalogue.roles.map((role) => role.name),
    }),
  );
  await writeFile(
    join(directory, 'active-registry.json'),
    JSON.stringify({
      environment: 'local',
      generation: 1,
      revision: 'a'.repeat(64),
      permissions: catalogue.permissions,
      roles: catalogue.roles,
      groups: [],
    }),
  );
  const app = express();
  app.use(express.json());
  app.use((_req, res, next) => {
    res.locals.principal = {
      subject: actor,
      sessionId: 'actor-session',
      authTime: Math.floor(Date.now() / 1000),
      authenticationMethod: 'webauthn-passwordless',
      ...assurance,
      roles: signedRoles,
      effectiveRoleNames: currentRoles,
    };
    res.locals.identityEnvironment = 'local';
    next();
  });
  app.use(
    createIdentityRouter(client, logger, {
      ...config,
      APP_AUTHORIZATION_CATALOGUE_PATH: cataloguePath,
    }),
  );
  app.use(errorHandler);
  const server = app.listen(0, '127.0.0.1');
  servers.push(server);
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No port');
  const request = (path: string, method = 'GET', body?: unknown) =>
    fetch(`http://127.0.0.1:${address.port}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer fixture-user-token' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  return { client, request };
}
describe('administration contracts', () => {
  it('blocks self deletion and self disabling without calling the provider', async () => {
    const { client, request } = await setup();
    expect((await request(`/users/${actor}`, 'DELETE')).status).toBe(409);
    expect((await request(`/users/${actor}`, 'PATCH', { enabled: false })).status).toBe(409);
    expect(client.deleteUser).not.toHaveBeenCalled();
    expect(client.updateUser).not.toHaveBeenCalled();
  });
  it('blocks self demotion and rejects invalid input', async () => {
    const { client, request } = await setup();
    expect((await request(`/users/${actor}/roles`, 'PUT', { roles: ['member'] })).status).toBe(409);
    expect((await request(`/users/${target}`, 'PATCH', { email: 'invalid' })).status).toBe(400);
    expect((await request(`/users/${target}`, 'PATCH', { emailVerified: true })).status).toBe(400);
    expect(client.replaceManagedRealmRoles).not.toHaveBeenCalled();
  });
  it('deactivates and revokes sessions in the API, without relying on UI', async () => {
    const { client, request } = await setup();
    expect((await request(`/users/${target}`, 'PATCH', { enabled: false })).status).toBe(204);
    expect(client.logoutUser).toHaveBeenCalledWith(target);
  });
  it('rejects legacy password actions without touching the provider', async () => {
    const { client, request } = await setup([
      'identity:users:update:password',
      'identity:users:send-password-reset',
    ]);
    expect(
      (await request(`/users/${target}/password`, 'PUT', { password: 'temporary-password-123' }))
        .status,
    ).toBe(404);
    expect((await request(`/users/${target}/send-password-reset`, 'POST')).status).toBe(404);
    expect(client.setPassword).not.toHaveBeenCalled();
    expect(client.executeActionsEmail).not.toHaveBeenCalled();
  });
  it('returns the created ID even when subsequent setup fails', async () => {
    const { client, request } = await setup();
    client.replaceManagedRealmRoles.mockRejectedValueOnce(new Error('offline'));
    const response = await request('/users', 'POST', {
      username: 'new-user',
      email: 'new@example.test',
    });
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ id: target, setupPending: true });
    expect(client.replaceManagedRealmRoles).toHaveBeenCalledWith(target, ['member']);
    expect(client.executeActionsEmail).not.toHaveBeenCalled();
  });
  it('creates a permission-free member and sends verification to the configured Account application', async () => {
    const { client, request } = await setup();
    const response = await request('/users', 'POST', {
      username: 'new-member',
      email: 'new@example.test',
      sendVerifyEmail: true,
    });
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ id: target, setupPending: false });
    expect(client.replaceManagedRealmRoles).toHaveBeenCalledWith(target, ['member']);
    expect(client.executeActionsEmail).toHaveBeenCalledWith(target, ['VERIFY_EMAIL'], {
      lifespan: 3600,
      clientId: 'identity-account-web',
      redirectUri: config.APP_ACCOUNT_PUBLIC_URL,
    });
  });
  it('assigns only applied roles that fit the signed and live delegation authority', async () => {
    const permitted = [entry, 'identity:users:update:roles', 'identity:users:view'];
    const allowed = await setup(permitted);
    expect(
      (await allowed.request(`/users/${target}/roles`, 'PUT', { roles: ['reader'] })).status,
    ).toBe(204);
    expect(allowed.client.replaceManagedRealmRoles).toHaveBeenCalledWith(target, ['reader']);
    const revoked = await setup(permitted, { effectiveRoleNames: [entry, 'identity:users:view'] });
    expect(
      (await revoked.request(`/users/${target}/roles`, 'PUT', { roles: ['reader'] })).status,
    ).toBe(403);
    expect(revoked.client.replaceManagedRealmRoles).not.toHaveBeenCalled();
  });
  it('does not let a delegated operator disable or delete a protected administrator', async () => {
    const { client, request } = await setup([
      entry,
      'identity:users:delete',
      'identity:users:deactivate',
    ]);
    client.getUserRealmEffectiveRoles.mockImplementation(async (id: string) =>
      (id === target ? ['administrador', entry] : []).map((name) => ({ id: name, name })),
    );
    expect((await request(`/users/${target}`, 'DELETE')).status).toBe(403);
    expect((await request(`/users/${target}`, 'PATCH', { enabled: false })).status).toBe(403);
    expect(client.deleteUser).not.toHaveBeenCalled();
    expect(client.updateUser).not.toHaveBeenCalled();
  });
});

describe('recent operator authentication', () => {
  it('reports recent passkey assurance without requiring a generic administrator role', async () => {
    const { request } = await setup([]);
    const status = await request('/support-assurance');
    expect(status.status).toBe(200);
    expect(await status.json()).toEqual({ verified: true, expiresAt: expect.any(Number) });
  });
  it.each([
    { authTime: undefined },
    { authTime: Math.floor(Date.now() / 1000) - 300 },
    { authTime: Math.floor(Date.now() / 1000) + 30 },
    { authTime: NaN },
    { authenticationMethod: 'email-otp' },
    { authenticationMethod: 'otp' },
    { sessionId: undefined },
  ])('blocks destructive actions for insufficient assurance %j', async (assurance) => {
    const { request, client } = await setup(undefined, assurance);
    expect(await (await request('/support-assurance')).json()).toEqual({
      verified: false,
      expiresAt: null,
    });
    for (const response of [
      await request(`/users/${target}`, 'DELETE'),
      await request(`/users/${target}`, 'PATCH', { enabled: false }),
      await request(`/users/${target}/credentials/key`, 'DELETE', {
        reason: 'Lost device',
        confirmed: true,
      }),
    ]) {
      expect(response.status).toBe(403);
      expect((await response.json()).error.code).toBe('recent_authentication_required');
    }
    expect(client.deleteUser).not.toHaveBeenCalled();
    expect(client.updateUser).not.toHaveBeenCalled();
    expect(client.deleteCredential).not.toHaveBeenCalled();
  });
  it('blocks a revoked live session even when the signed authentication time is recent', async () => {
    const { request, client } = await setup();
    client.listSessions.mockResolvedValue([]);
    expect((await request(`/users/${target}`, 'DELETE')).status).toBe(403);
    expect(client.deleteUser).not.toHaveBeenCalled();
  });
  it('permits deletion after recent passkey authentication and does not gate ordinary profile edits', async () => {
    const recent = await setup(['identity:users:delete']);
    expect((await recent.request(`/users/${target}`, 'DELETE')).status).toBe(204);
    expect(recent.client.deleteUser).toHaveBeenCalledWith(target);
    const stale = await setup(['identity:users:update:name'], { authTime: 1 });
    expect(
      (await stale.request(`/users/${target}`, 'PATCH', { firstName: 'Updated' })).status,
    ).toBe(204);
  });
});

describe('security monitoring', () => {
  it('validates filters and forwards bounded pagination', async () => {
    const { request, client } = await setup();
    expect((await request('/security-events?type=LOGIN&max=50&first=0')).status).toBe(200);
    expect(client.listSecurityEvents).toHaveBeenCalledWith({ type: 'LOGIN', max: 50, first: 0 });
    expect(
      (await request('/security-events?search=%20sphere%20&first=25&max=25&type=LOGIN')).status,
    ).toBe(200);
    expect(client.listSecurityEvents).toHaveBeenLastCalledWith({
      search: 'sphere',
      first: 25,
      max: 25,
      type: 'LOGIN',
    });
    expect((await request('/security-events?search=' + 'x'.repeat(151))).status).toBe(400);
    expect((await request('/security-events?max=1000')).status).toBe(400);
    expect((await request('/security-events?dateFrom=not-a-date')).status).toBe(400);
  });
});

it('requires the user-view permission for the monitoring endpoint', async () => {
  const { request, client } = await setup(['administrador']);
  expect((await request('/security-events')).status).toBe(403);
  expect(client.listSecurityEvents).not.toHaveBeenCalled();
});

describe('support methods', () => {
  it('requires distinct credential permissions and strips provider secrets', async () => {
    const denied = await setup(['identity:users:view']);
    expect((await denied.request(`/users/${target}/credentials`)).status).toBe(403);
    expect(
      (
        await denied.request(`/users/${target}/credentials/key`, 'DELETE', {
          reason: 'Lost device',
          confirmed: true,
        })
      ).status,
    ).toBe(403);
    expect(denied.client.listCredentials).not.toHaveBeenCalled();
    const allowed = await setup(['identity:users:credentials:view']);
    allowed.client.listCredentials.mockResolvedValueOnce([
      { id: 'key', type: 'webauthn-passwordless', secretData: 'never expose' },
    ]);
    const response = await allowed.request(`/users/${target}/credentials`);
    expect(await response.json()).toEqual({
      credentials: [{ id: 'key', type: 'webauthn-passwordless' }],
      requiresPasskey: false,
    });
  });
  it('validates confirmation and reason, forwarding the user token to the provider', async () => {
    const { client, request } = await setup(['identity:users:credentials:delete']);
    expect(
      (await request(`/users/${target}/credentials/key`, 'DELETE', { reason: 'Lost device' }))
        .status,
    ).toBe(400);
    expect(client.deleteCredential).not.toHaveBeenCalled();
    expect(
      (
        await request(`/users/${target}/credentials/key`, 'DELETE', {
          reason: 'Lost device',
          confirmed: true,
        })
      ).status,
    ).toBe(204);
    expect(client.deleteCredential).toHaveBeenCalledWith(
      target,
      'key',
      'fixture-user-token',
      'Lost device',
    );
  });
  it('reserves the shared cooldown before requesting verification', async () => {
    const { client, request } = await setup(['identity:users:send-verification']);
    expect((await request(`/users/${target}/send-verification`, 'POST')).status).toBe(204);
    expect(client.reserveVerification).toHaveBeenCalledWith(target, 'fixture-user-token');
    expect(client.executeActionsEmail).toHaveBeenCalledWith(target, ['VERIFY_EMAIL'], {
      lifespan: 3600,
      clientId: 'identity-account-web',
      redirectUri: config.APP_ACCOUNT_PUBLIC_URL,
    });
    client.reserveVerification.mockRejectedValueOnce(
      new (await import('@scoretech/identity-internal')).HttpError(429, 'cooldown', 'Wait'),
    );
    expect((await request(`/users/${target}/send-verification`, 'POST')).status).toBe(429);
    expect(client.executeActionsEmail).toHaveBeenCalledTimes(1);
  });
});

const recoveryBody = {
  reason: 'User cannot access the OTP',
  identityVerified: true,
};
it('issues a recovery link only with its atomic permission and fresh passkey, without logging the link', async () => {
  const { request, client } = await setup(['identity:users:recovery:create']);
  const response = await request(`/users/${target}/recovery`, 'POST', recoveryBody);
  expect(response.status).toBe(201);
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(client.createRecovery).toHaveBeenCalledWith(target, 'fixture-user-token', recoveryBody);
  const event = logger.info.mock.calls.find((call) =>
    JSON.stringify(call).includes('user.recovery_created'),
  );
  expect(JSON.stringify(event)).not.toContain('#fixture');
});
it('rejects missing recovery permission, stale or scoped authentication and unconfirmed identity', async () => {
  for (const [permissions, assurance, body, expected] of [
    [[], {}, recoveryBody, 403],
    [['identity:users:recovery:create'], { authTime: 1 }, recoveryBody, 403],
    [['identity:users:recovery:create'], { authenticationMethod: 'email-otp' }, recoveryBody, 403],
    [
      ['identity:users:recovery:create'],
      { stepUpScope: 'user:other:credentials' },
      recoveryBody,
      403,
    ],
    [['identity:users:recovery:create'], {}, { ...recoveryBody, identityVerified: false }, 400],
  ] as const) {
    const { request, client } = await setup([...permissions], assurance);
    expect((await request(`/users/${target}/recovery`, 'POST', body)).status).toBe(expected);
    expect(client.createRecovery).not.toHaveBeenCalled();
  }
});
it('requires the separate revocation permission and forwards only validated identifiers', async () => {
  const { request, client } = await setup(['identity:users:recovery:revoke']);
  expect((await request(`/users/${target}/recovery/${actor}`, 'DELETE')).status).toBe(204);
  expect(client.revokeRecovery).toHaveBeenCalledWith(target, actor, 'fixture-user-token');
  expect((await request(`/users/${target}/recovery/not-a-uuid`, 'DELETE')).status).toBe(400);
});

it('reads recovery metadata with its view permission without requiring a fresh passkey', async () => {
  const { request, client } = await setup(['identity:users:recovery:view'], { authTime: 1 });
  expect((await request(`/users/${target}/recovery`)).status).toBe(200);
  expect(client.recoveryStatus).toHaveBeenCalledWith(target, 'fixture-user-token');
});

it('prepares a server-owned recovery ID with create permission and ignores forged case references at issuance', async () => {
  const { request, client } = await setup(['identity:users:recovery:create']);
  expect((await request(`/users/${target}/recovery/prepare`, 'POST')).status).toBe(200);
  expect(client.prepareRecovery).toHaveBeenCalledWith(target, 'fixture-user-token');
  const response = await request(`/users/${target}/recovery`, 'POST', {
    ...recoveryBody,
    draftId: target,
    caseReference: 'FORGED',
  });
  expect(response.status).toBe(201);
  expect((await response.json()).caseReference).toBe('SOP-FIXTURE');
  expect(client.createRecovery).toHaveBeenCalledWith(target, 'fixture-user-token', {
    ...recoveryBody,
    draftId: target,
  });
  const unauthorized = await setup([]);
  expect((await unauthorized.request(`/users/${target}/recovery/prepare`, 'POST')).status).toBe(
    403,
  );
  expect(unauthorized.client.prepareRecovery).not.toHaveBeenCalled();
});

it('accepts dedicated deactivation assurance with only its atomic permission', async () => {
  const { request, client } = await setup(['identity:users:deactivate'], {
    stepUpScope: `user:${target}:deactivate`,
  });
  expect((await request(`/users/${target}`, 'PATCH', { enabled: false })).status).toBe(204);
  expect(client.updateUser).toHaveBeenCalledWith(target, { enabled: false });
  expect(client.logoutUser).toHaveBeenCalledWith(target);
  expect((await request(`/users/${target}`, 'DELETE')).status).toBe(403);
  expect(client.deleteUser).not.toHaveBeenCalled();
});

it('does not accept dedicated deactivation assurance for a different account or credential action', async () => {
  const { request, client } = await setup(undefined, { stepUpScope: `user:${actor}:deactivate` });
  expect((await request(`/users/${target}`, 'PATCH', { enabled: false })).status).toBe(403);
  expect(
    (
      await request(`/users/${actor}/credentials/key`, 'DELETE', {
        reason: 'Lost fixture device',
        confirmed: true,
      })
    ).status,
  ).toBe(403);
  expect(client.updateUser).not.toHaveBeenCalled();
  expect(client.deleteCredential).not.toHaveBeenCalled();
});
