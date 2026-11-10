import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { once } from 'node:events';
import type { Server } from 'node:http';
import type { IdentityAdminClient, Principal } from '@scoretech/identity-internal';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { loadConfig } from '../src/main/config/app-config.js';
import { createApp } from '../src/main/app.js';
import { createApplicationsRouter } from '../src/main/modules/applications/applications.routes.js';
import { errorHandler } from '../src/main/shared/http/errors.js';

// The shared JWT boundary is exercised by app.test.ts. Inject its verified
// principal here to isolate signed/live authorization and the provider protocol.
const manage = 'identity:roles:manage';
const view = 'identity:roles:view';
const clientId = 'score-app-11111111-1111-4111-8111-111111111111';
const otherClientId = 'score-app-22222222-2222-4222-8222-222222222222';
const version = '33333333-3333-4333-8333-333333333333';
const nextVersion = '44444444-4444-4444-8444-444444444444';
const clientSecret = 'fixture-confidential-client-secret-only';
const bearer = 'Bearer fixture-user-access-token';
const issuer = 'https://identity.score.example/identity/auth/realms/score';
const origin = 'https://application.score.example';
const servers: Server[] = [];

afterEach(async () => {
  servers.forEach((server) => server.closeAllConnections());
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

const settings = (overrides: Record<string, unknown> = {}) => ({
  name: 'Research application',
  kind: 'public',
  origin,
  redirectUris: [origin + '/auth/callback'],
  postLogoutRedirectUris: [origin + '/signed-out'],
  requiredPermissions: ['sphere:read'],
  enabled: true,
  ...overrides,
});
const application = (overrides: Record<string, unknown> = {}) => ({
  ...settings(),
  clientId,
  version,
  ...overrides,
});
const principal = (overrides: Partial<Principal> = {}): Principal => ({
  subject: '55555555-5555-4555-8555-555555555555',
  sessionId: 'fixture-session',
  roles: [manage],
  effectiveRoleNames: [manage, 'administrador'],
  ...overrides,
});
async function listen(app: express.Express): Promise<string> {
  const server = app.listen(0, '127.0.0.1');
  servers.push(server);
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No fixture server address.');
  return `http://127.0.0.1:${address.port}`;
}

async function fixture(
  options: {
    actor?: Principal;
    environment?: 'local' | 'staging' | 'production';
    status?: number;
    response?: unknown;
    rawResponse?: string;
    authenticatedApp?: boolean;
    verifiedPasskey?: boolean;
  } = {},
) {
  const providerCalls: { method: string; path: string; authorization?: string; body: unknown }[] =
    [];
  const provider = express();
  provider.use(express.json());
  const keys = options.authenticatedApp ? await generateKeyPair('RS256') : undefined;
  if (keys) {
    const jwk = await exportJWK(keys.publicKey);
    provider.get('/realms/score/protocol/openid-connect/certs', (_request, response) =>
      response.json({ keys: [{ ...jwk, kid: 'application-boundary', alg: 'RS256' }] }),
    );
  }
  provider.use((request, response) => {
    providerCalls.push({
      method: request.method,
      path: request.originalUrl,
      authorization: request.get('authorization'),
      body: request.body,
    });
    response.status(options.status ?? 200);
    if (options.rawResponse !== undefined)
      response.type('application/json').send(options.rawResponse);
    else response.json(options.response ?? { applications: [application()] });
  });
  const transport = await listen(provider);
  const config = loadConfig({
    APP_CORS_ORIGINS: 'http://localhost:18000',
    APP_KEYCLOAK_ISSUER: issuer,
    APP_KEYCLOAK_TRANSPORT_URL: transport + '/realms/score',
    APP_KEYCLOAK_ADMIN_URL: transport,
    APP_KEYCLOAK_REALM: 'score',
    APP_KEYCLOAK_ADMIN_CLIENT_SECRET: 'fixture-service-secret-never-forwarded',
    APP_IDENTITY_ENVIRONMENT: options.environment ?? 'local',
  });
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  let app: express.Express;
  let authorization = bearer;
  if (keys) {
    const roles = ['admin-web:local:access', manage, 'administrador'];
    const identityClient = {
      getUser: vi.fn(async (id: string) => ({ id, enabled: true, emailVerified: true })),
      getUserRealmEffectiveRoles: vi.fn(async () => roles.map((name) => ({ id: name, name }))),
      getUserRealmRoles: vi.fn(async () => roles.map((name) => ({ id: name, name }))),
      listSessions: vi.fn(async () => [{ id: 'fixture-session' }]),
    };
    app = createApp(config, {
      identityClient: identityClient as unknown as IdentityAdminClient,
      logger,
    });
    authorization =
      'Bearer ' +
      (await new SignJWT({
        realm_access: { roles },
        azp: 'identity-admin-web',
        sid: 'fixture-session',
        tentu_auth_method:
          options.verifiedPasskey === false ? 'email-otp' : 'webauthn-passwordless',
        tentu_admin_verified: options.verifiedPasskey !== false,
      })
        .setProtectedHeader({ alg: 'RS256', kid: 'application-boundary' })
        .setIssuer(issuer)
        .setAudience('identity-admin-api')
        .setSubject(principal().subject)
        .setExpirationTime('5m')
        .sign(keys.privateKey));
  } else {
    app = express();
    app.use(express.json({ limit: '64kb' }));
    app.use((_request, response, next) => {
      response.locals.principal = options.actor ?? principal();
      next();
    });
    app.use('/v1/applications', createApplicationsRouter(config, logger));
    app.use((_request, response) => response.status(404).json({ error: { code: 'not_found' } }));
    app.use(errorHandler);
  }
  const base = await listen(app);
  const request = (path = '', method = 'GET', body?: unknown) =>
    fetch(base + '/v1/applications' + path, {
      method,
      headers: { Authorization: authorization, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: 'manual',
    });
  return { request, providerCalls, logger };
}

describe('managed applications authorization', () => {
  it.each([
    ['support', { roles: [view], effectiveRoleNames: [view] }],
    ['delegated manager', { roles: [manage], effectiveRoleNames: [manage] }],
    ['stale protected role', { roles: [manage, 'administrador'], effectiveRoleNames: [manage] }],
    ['missing signed management', { roles: [view], effectiveRoleNames: [manage, 'administrador'] }],
    ['revoked management', { roles: [manage], effectiveRoleNames: ['administrador'] }],
    ['missing current state', { roles: [manage], effectiveRoleNames: undefined }],
  ])('denies reads and every write for %s before provider access', async (_name, actor) => {
    const f = await fixture({ actor: principal(actor as Partial<Principal>) });
    for (const [path, method, body] of [
      ['', 'GET', undefined],
      ['', 'POST', settings()],
      ['/' + clientId, 'PUT', { ...settings(), version }],
      ['/' + clientId, 'DELETE', { version }],
      ['/' + clientId + '/secret', 'POST', { version }],
      ['/' + clientId + '/secret/reveal', 'POST', { version }],
    ] as const) {
      const response = await f.request(path, method, body);
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ error: { code: 'protected_configuration' } });
    }
    expect(f.providerCalls).toEqual([]);
  });

  it('admits a current protected administrator without requiring the generic role in the signed token', async () => {
    const f = await fixture();
    expect(principal().roles).not.toContain('administrador');
    const response = await f.request();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      applications: [application()],
      issuer,
      discoveryUrl: issuer + '/.well-known/openid-configuration',
      capabilities: { manageApplications: true },
    });
    expect(f.providerCalls).toEqual([
      {
        method: 'GET',
        path: '/realms/score/score-applications',
        authorization: bearer,
        body: undefined,
      },
    ]);
  });
});

describe('managed application deletion', () => {
  it('forwards only the current UUID version with DELETE and projects an ID-bound confirmation', async () => {
    const f = await fixture({
      response: { clientId, deleted: true, clientSecret, privateDetails: 'not-public' },
    });
    const response = await f.request('/' + clientId, 'DELETE', { version });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ clientId, deleted: true });
    expect(f.providerCalls).toEqual([
      {
        method: 'DELETE',
        path: '/realms/score/score-applications/' + clientId,
        authorization: bearer,
        body: { version },
      },
    ]);
    expect(JSON.stringify(f.logger.info.mock.calls)).not.toContain(clientSecret);
  });

  it('uses the authenticated app boundary and does not cache a successful deletion confirmation', async () => {
    const f = await fixture({ authenticatedApp: true, response: { clientId, deleted: true } });
    const response = await f.request('/' + clientId, 'DELETE', { version });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ clientId, deleted: true });
    expect(f.providerCalls).toHaveLength(1);
    expect(f.providerCalls[0]!.authorization).toMatch(/^Bearer ey/);
  });

  it('requires signed passkey proof even when the current administrator has deletion authority', async () => {
    const f = await fixture({ authenticatedApp: true, verifiedPasskey: false });
    const response = await f.request('/' + clientId, 'DELETE', { version });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      error: { code: 'administrative_passkey_required' },
    });
    expect(f.providerCalls).toEqual([]);
  });

  it.each([
    undefined,
    {},
    { version: 0 },
    { version: 'not-a-uuid' },
    { version, clientId: 'identity-admin-web' },
    { version, roles: ['administrador'] },
  ])('requires a strict current-version deletion body (%j)', async (body) => {
    const f = await fixture();
    expect((await f.request('/' + clientId, 'DELETE', body)).status).toBe(400);
    expect(f.providerCalls).toEqual([]);
  });

  it.each([
    { clientId: otherClientId, deleted: true },
    { clientId: 'identity-admin-web', deleted: true },
    { clientId, deleted: false },
    { clientId, deleted: 'true' },
    { clientId },
    { deleted: true },
  ])('rejects forged or incomplete provider deletion confirmations (%j)', async (result) => {
    const f = await fixture({ response: result });
    const response = await f.request('/' + clientId, 'DELETE', { version });
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ error: { code: 'invalid_provider_response' } });
  });

  it.each([409, 404])(
    'preserves native deletion failure %s without returning private details',
    async (status) => {
      const f = await fixture({
        status,
        response: { clientSecret, diagnostic: 'private deletion failure' },
      });
      const response = await f.request('/' + clientId, 'DELETE', { version });
      expect(response.status).toBe(status);
      const body = await response.json();
      expect(body).toMatchObject({ error: { code: 'application_operation_failed' } });
      expect(JSON.stringify(body)).not.toContain(clientSecret);
      expect(JSON.stringify(body)).not.toContain('private deletion failure');
      expect(f.providerCalls).toHaveLength(1);
    },
  );

  it.each(['identity-admin-web', 'identity-config-sync', 'account', 'unmanaged-client'])(
    'does not forward deletion of protected or unmanaged client ID %s',
    async (id) => {
      const f = await fixture();
      expect((await f.request('/' + id, 'DELETE', { version })).status).toBe(400);
      expect(f.providerCalls).toEqual([]);
    },
  );
});

describe('explicit confidential secret reveal', () => {
  it('returns only the requested current credential and stable version without invoking rotation', async () => {
    const expected = { clientId, clientSecret, version };
    const f = await fixture({
      response: { ...expected, application: application(), internalDetails: 'private' },
    });
    const response = await f.request('/' + clientId + '/secret/reveal', 'POST', { version });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(expected);
    expect(f.providerCalls).toEqual([
      {
        method: 'POST',
        path: '/realms/score/score-applications/' + clientId + '/secret/reveal',
        authorization: bearer,
        body: { version },
      },
    ]);
    expect(JSON.stringify(f.logger.info.mock.calls)).not.toContain(clientSecret);
  });

  it('uses the real JWT/live authorization boundary and forbids caching the revealed credential', async () => {
    const f = await fixture({
      authenticatedApp: true,
      response: { clientId, clientSecret, version },
    });
    const response = await f.request('/' + clientId + '/secret/reveal', 'POST', { version });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ clientId, clientSecret, version });
    expect(f.providerCalls).toHaveLength(1);
    expect(f.providerCalls[0]!.authorization).toMatch(/^Bearer ey/);
    expect(JSON.stringify(f.logger.info.mock.calls)).not.toContain(clientSecret);
  });

  it('rejects reveal with a valid signed email-only session despite current protected administrator rights', async () => {
    const f = await fixture({ authenticatedApp: true, verifiedPasskey: false });
    const response = await f.request('/' + clientId + '/secret/reveal', 'POST', { version });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      error: { code: 'administrative_passkey_required' },
    });
    expect(f.providerCalls).toEqual([]);
  });

  it.each([
    { clientId: otherClientId, clientSecret, version },
    { clientId, clientSecret, version: nextVersion },
    { clientId, clientSecret, version: 'not-a-uuid' },
    { clientId: 'unmanaged-client', clientSecret, version },
    { clientId, clientSecret: 'short', version },
    { clientId, version },
    { clientId, clientSecret },
  ])(
    'rejects malformed, mismatched or stale successful provider reveal responses (%j)',
    async (result) => {
      const f = await fixture({ response: result });
      const response = await f.request('/' + clientId + '/secret/reveal', 'POST', { version });
      expect(response.status).toBe(502);
      const body = await response.json();
      expect(body).toMatchObject({ error: { code: 'invalid_provider_response' } });
      expect(JSON.stringify(body)).not.toContain(clientSecret);
    },
  );

  it.each([
    {},
    { version: 0 },
    { version: 'not-a-uuid' },
    { version, clientSecret: 'caller-supplied' },
  ])('requires the strict current UUID version request before revealing (%j)', async (body) => {
    const f = await fixture();
    expect((await f.request('/' + clientId + '/secret/reveal', 'POST', body)).status).toBe(400);
    expect(f.providerCalls).toEqual([]);
  });

  it.each(['stale version', 'public client'])(
    'preserves native %s conflicts without exposing a credential',
    async (reason) => {
      const f = await fixture({
        status: 409,
        response: { clientSecret, diagnostic: 'private ' + reason },
      });
      const response = await f.request('/' + clientId + '/secret/reveal', 'POST', { version });
      expect(response.status).toBe(409);
      const body = await response.json();
      expect(body).toMatchObject({ error: { code: 'application_operation_failed' } });
      expect(JSON.stringify(body)).not.toContain(clientSecret);
      expect(JSON.stringify(body)).not.toContain('private ' + reason);
    },
  );

  it('does not expose a GET reveal route or forward a reveal for an unmanaged ID', async () => {
    const f = await fixture();
    expect((await f.request('/' + clientId + '/secret/reveal')).status).toBe(404);
    expect((await f.request('/unmanaged-client/secret/reveal', 'POST', { version })).status).toBe(
      400,
    );
    expect(f.providerCalls).toEqual([]);
  });
});

describe('managed application creation and safe projection', () => {
  it('projects list metadata without provider credentials or unrelated fields', async () => {
    const f = await fixture({
      response: {
        applications: [
          { ...application(), clientSecret, registrationAccessToken: 'fixture-private-token' },
        ],
        clientSecret,
        privateDetails: 'not-public',
      },
    });
    const response = await f.request();
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.applications).toEqual([application()]);
    expect(JSON.stringify(body)).not.toContain(clientSecret);
    expect(JSON.stringify(body)).not.toContain('fixture-private-token');
    expect(body).not.toHaveProperty('privateDetails');
  });

  it.each(['public', 'confidential'])(
    'creates a generated %s client and forwards only validated settings with the user bearer',
    async (kind) => {
      const result = {
        application: application({ kind }),
        ...(kind === 'confidential' ? { clientSecret } : {}),
      };
      const f = await fixture({ response: result });
      const input = settings({ kind });
      const response = await f.request('', 'POST', input);
      expect(response.status).toBe(201);
      expect(await response.json()).toEqual(result);
      expect(f.providerCalls).toEqual([
        {
          method: 'POST',
          path: '/realms/score/score-applications',
          authorization: bearer,
          body: input,
        },
      ]);
      expect(JSON.stringify(f.logger.info.mock.calls)).not.toContain(clientSecret);
      expect(JSON.stringify(f.providerCalls)).not.toContain(
        'fixture-service-secret-never-forwarded',
      );
    },
  );

  it.each([
    ['public', { application: application(), clientSecret }],
    ['confidential', { application: application({ kind: 'confidential' }) }],
    ['public', { application: application({ kind: 'confidential' }) }],
  ])(
    'rejects inconsistent provider credentials or kind for a requested %s client',
    async (kind, result) => {
      const f = await fixture({ response: result });
      const response = await f.request('', 'POST', settings({ kind }));
      expect(response.status).toBe(502);
      const body = await response.json();
      expect(body).toMatchObject({ error: { code: 'invalid_provider_response' } });
      expect(JSON.stringify(body)).not.toContain(clientSecret);
    },
  );

  it.each(['clientId', 'version', 'clientSecret', 'serviceAccountsEnabled', 'userUri'])(
    'rejects caller-controlled %s during creation',
    async (field) => {
      const f = await fixture();
      const response = await f.request(
        '',
        'POST',
        settings({ [field]: field === 'clientId' ? clientId : 'https://attacker.example/client' }),
      );
      expect(response.status).toBe(400);
      expect(f.providerCalls).toEqual([]);
    },
  );

  it.each([
    { origin: origin + '/' },
    { origin: 'https://*.score.example' },
    { redirectUris: ['https://application.score.example.evil/auth/callback'] },
    { redirectUris: ['https://attacker.example/auth/callback'] },
    { redirectUris: [origin + '/*'] },
    { redirectUris: ['https://user:password@application.score.example/auth/callback'] },
    { redirectUris: [origin + '/auth/callback#fragment'] },
    { postLogoutRedirectUris: ['https://attacker.example/signed-out'] },
    { redirectUris: [origin + '/callback', origin + '/callback'] },
    { postLogoutRedirectUris: [origin + '/signed-out', origin + '/signed-out'] },
    { requiredPermissions: ['sphere:read', 'sphere:read'] },
    { requiredPermissions: [] },
    { requiredPermissions: ['identity:users:view'] },
    { name: 'x'.repeat(151) },
    { redirectUris: Array.from({ length: 11 }, (_, index) => origin + '/callback/' + index) },
    {
      postLogoutRedirectUris: Array.from({ length: 11 }, (_, index) => origin + '/logout/' + index),
    },
  ])(
    'rejects invalid or overbroad application settings before forwarding (%j)',
    async (invalid) => {
      const f = await fixture();
      expect((await f.request('', 'POST', settings(invalid))).status).toBe(400);
      expect(f.providerCalls).toEqual([]);
    },
  );

  it.each(['POST', 'PUT'])(
    'rejects HTTP loopback origins in deployed %s settings before provider access',
    async (method) => {
      const f = await fixture({ environment: 'production' });
      const input = settings({
        origin: 'http://localhost:18000',
        redirectUris: ['http://localhost:18000/callback'],
        postLogoutRedirectUris: [],
      });
      const response = await f.request(
        method === 'POST' ? '' : '/' + clientId,
        method,
        method === 'POST' ? input : { ...input, version },
      );
      expect(response.status).toBe(400);
      expect(f.providerCalls).toEqual([]);
    },
  );
});

describe('managed application versions and client boundaries', () => {
  it('forwards the version and enabled toggle on public PUT without leaking provider extra metadata', async () => {
    const result = application({ enabled: false, version: nextVersion });
    const f = await fixture({
      response: { application: result, privateMetadata: { clientSecret } },
    });
    const input = { ...settings({ enabled: false }), version };
    const response = await f.request('/' + clientId, 'PUT', input);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ application: result });
    expect(f.providerCalls).toEqual([
      {
        method: 'PUT',
        path: '/realms/score/score-applications/' + clientId,
        authorization: bearer,
        body: input,
      },
    ]);
  });

  it('preserves a fresh one-time secret returned when PUT changes an application to confidential', async () => {
    const result = {
      application: application({ kind: 'confidential', version: nextVersion }),
      clientSecret,
    };
    const f = await fixture({ response: result });
    const input = { ...settings({ kind: 'confidential' }), version };
    const response = await f.request('/' + clientId, 'PUT', input);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(result);
    expect(f.providerCalls).toEqual([
      {
        method: 'PUT',
        path: '/realms/score/score-applications/' + clientId,
        authorization: bearer,
        body: input,
      },
    ]);
    expect(result.application.clientId).toBe(clientId);
    expect(JSON.stringify(f.logger.info.mock.calls)).not.toContain(clientSecret);
  });

  it('accepts an ordinary confidential update without returning its existing secret', async () => {
    const result = application({
      kind: 'confidential',
      name: 'Renamed server application',
      version: nextVersion,
    });
    const f = await fixture({ response: { application: result } });
    const response = await f.request('/' + clientId, 'PUT', {
      ...settings({ kind: 'confidential', name: result.name }),
      version,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ application: result });
  });

  it('rejects a provider secret on a public update instead of silently dropping or exposing it', async () => {
    const f = await fixture({
      response: { application: application({ version: nextVersion }), clientSecret },
    });
    const response = await f.request('/' + clientId, 'PUT', { ...settings(), version });
    expect(response.status).toBe(502);
    const body = await response.json();
    expect(body).toMatchObject({ error: { code: 'invalid_provider_response' } });
    expect(JSON.stringify(body)).not.toContain(clientSecret);
  });

  it('still rejects a returned kind differing from the requested update kind', async () => {
    const f = await fixture({
      response: { application: application({ kind: 'public', version: nextVersion }) },
    });
    const response = await f.request('/' + clientId, 'PUT', {
      ...settings({ kind: 'confidential' }),
      version,
    });
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ error: { code: 'invalid_provider_response' } });
  });

  it('rotates a confidential secret with an exact UUID version and one-time credential response', async () => {
    const result = {
      application: application({ kind: 'confidential', version: nextVersion }),
      clientId,
      clientSecret,
    };
    const f = await fixture({ response: result });
    const response = await f.request('/' + clientId + '/secret', 'POST', { version });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(result);
    expect(f.providerCalls).toEqual([
      {
        method: 'POST',
        path: '/realms/score/score-applications/' + clientId + '/secret',
        authorization: bearer,
        body: { version },
      },
    ]);
    expect(JSON.stringify(f.logger.info.mock.calls)).not.toContain(clientSecret);
  });

  it.each([
    {},
    { version: 1 },
    { version: 'not-a-uuid' },
    { version, clientSecret: 'caller-supplied' },
  ])('requires a strict UUID version body on rotation (%j)', async (body) => {
    const f = await fixture();
    expect((await f.request('/' + clientId + '/secret', 'POST', body)).status).toBe(400);
    expect(f.providerCalls).toEqual([]);
  });

  it.each([undefined, 'not-a-uuid', 1])(
    'requires a UUID version on update (%j)',
    async (badVersion) => {
      const f = await fixture();
      expect(
        (await f.request('/' + clientId, 'PUT', { ...settings(), version: badVersion })).status,
      ).toBe(400);
      expect(f.providerCalls).toEqual([]);
    },
  );

  it.each(['PUT', 'ROTATE'])('rejects provider identity mismatches for %s', async (operation) => {
    const result = {
      application: application({ clientId: otherClientId, kind: 'confidential' }),
      clientId: otherClientId,
      clientSecret,
    };
    const f = await fixture({ response: result });
    const response = await f.request(
      '/' + clientId + (operation === 'ROTATE' ? '/secret' : ''),
      operation === 'ROTATE' ? 'POST' : 'PUT',
      operation === 'ROTATE' ? { version } : { ...settings({ kind: 'confidential' }), version },
    );
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ error: { code: 'invalid_provider_response' } });
  });

  it('rejects a mismatched top-level rotated client identity even if the application matches', async () => {
    const f = await fixture({
      response: {
        application: application({ kind: 'confidential' }),
        clientId: otherClientId,
        clientSecret,
      },
    });
    const response = await f.request('/' + clientId + '/secret', 'POST', { version });
    expect(response.status).toBe(502);
  });

  it('preserves provider version conflicts during a kind change without exposing diagnostics', async () => {
    const f = await fixture({
      status: 409,
      response: { internalError: 'private version-conflict diagnostic' },
    });
    const response = await f.request('/' + clientId, 'PUT', {
      ...settings({ kind: 'confidential' }),
      version,
    });
    expect(response.status).toBe(409);
    expect(JSON.stringify(await response.json())).not.toContain(
      'private version-conflict diagnostic',
    );
    expect(f.providerCalls[0]!.body).toMatchObject({ kind: 'confidential', version });
  });

  it('does not expose unmanaged client mutations or dynamic registration', async () => {
    const f = await fixture();
    for (const [path, method, body, expected] of [
      ['/identity-admin-web', 'PUT', { ...settings(), version }, 400],
      ['/unmanaged-client/secret', 'POST', { version }, 400],
      ['/unmanaged-client', 'POST', settings(), 404],
      ['/identity-admin-web', 'DELETE', { version }, 400],
      ['/register', 'POST', settings(), 404],
    ] as const)
      expect((await f.request(path, method, body)).status).toBe(expected);
    expect(f.providerCalls).toEqual([]);
  });
});

describe('managed application provider errors', () => {
  it.each([400, 401, 403, 404, 409, 429, 500, 502, 503])(
    'maps upstream %s without returning private error bodies',
    async (status) => {
      const f = await fixture({
        status,
        response: { clientSecret, databaseTrace: 'private-provider-detail' },
      });
      const response = await f.request();
      expect(response.status).toBe(status >= 500 ? 503 : status);
      const body = await response.json();
      expect(body).toMatchObject({ error: { code: 'application_operation_failed' } });
      expect(JSON.stringify(body)).not.toContain(clientSecret);
      expect(JSON.stringify(body)).not.toContain('private-provider-detail');
    },
  );

  it.each([
    { applications: [{ ...application(), version: 'not-a-uuid' }] },
    { applications: [application({ clientId: 'unmanaged-client' })] },
    { applications: [settings()] },
  ])('rejects malformed application metadata from the provider (%j)', async (result) => {
    const f = await fixture({ response: result });
    const response = await f.request();
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ error: { code: 'invalid_provider_response' } });
  });

  it('classifies malformed provider JSON as an upstream failure, not invalid user input', async () => {
    const f = await fixture({ rawResponse: '{"applications":' });
    const response = await f.request();
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ error: { code: 'invalid_provider_response' } });
  });
});
