import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest';
import { once } from 'node:events';
import { type Server } from 'node:http';
import express from 'express';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { createApp } from '../src/main/app.js';
import { loadConfig } from '../src/main/config/app-config.js';
const servers: Server[] = [];
let issuer: string;
let base: string;
let passkeyBase: string;
let keys: Awaited<ReturnType<typeof generateKeyPair>>;
const client = {
  getUser: vi.fn().mockResolvedValue({
    id: 'owner',
    enabled: true,
    emailVerified: true,
    attributes: {
      private: ['hidden'],
      tentuTaxDocumentNumber: ['12345678Z'],
      tentuWooCustomerId: ['123'],
    },
  }),
  updateUser: vi.fn(),
  getUserRealmRoles: vi.fn().mockResolvedValue([]),
  getUserRealmEffectiveRoles: vi.fn().mockResolvedValue([
    { id: 'student', name: 'alumno' },
    { id: 'permission', name: 'analytics:production:access' },
    { id: 'internal', name: 'realm-admin' },
  ]),
  listSessions: vi.fn().mockResolvedValue([]),
  logoutSession: vi.fn(),
  logoutUser: vi.fn(),
  executeActionsEmail: vi.fn(),
};
async function listen(app: express.Express) {
  const server = app.listen(0, '127.0.0.1');
  servers.push(server);
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No address');
  return `http://127.0.0.1:${address.port}`;
}
beforeAll(async () => {
  keys = await generateKeyPair('RS256');
  const jwk = await exportJWK(keys.publicKey);
  const jwks = express();
  jwks.get('/realms/test/protocol/openid-connect/certs', (_req, res) =>
    res.json({ keys: [{ ...jwk, kid: 'test', alg: 'RS256' }] }),
  );
  issuer = `${await listen(jwks)}/realms/test`;
  const config = loadConfig({
    APP_CORS_ORIGINS: 'https://id.example.test',
    APP_KEYCLOAK_ISSUER: issuer,
    APP_KEYCLOAK_ADMIN_URL: issuer,
    APP_KEYCLOAK_REALM: 'test',
    APP_KEYCLOAK_ADMIN_CLIENT_SECRET: 'fixture',
    APP_ACCOUNT_PUBLIC_URL: 'https://id.example.test',
  });
  base = await listen(
    createApp(config, {
      identityClient: client,
      authorizationCatalogue: { roles: ['alumno'], permissions: ['analytics:production:access'] },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    }),
  );
  passkeyBase = await listen(
    createApp(
      { ...config, APP_REQUIRE_ADMIN_PASSKEY: true },
      {
        identityClient: client,
        authorizationCatalogue: {
          roles: ['alumno', 'administrador'],
          permissions: ['analytics:production:access'],
        },
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      },
    ),
  );
});
afterAll(async () => {
  await Promise.all(
    servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});
async function token(
  options: {
    aud?: string;
    iss?: string;
    exp?: boolean;
    subject?: boolean;
    session?: boolean;
    forged?: boolean;
    passkey?: boolean;
  } = {},
) {
  let jwt = new SignJWT({
    realm_access: { roles: ['alumno'] },
    ...(options.passkey
      ? { tentu_auth_method: 'webauthn-passwordless', tentu_admin_verified: true }
      : {}),
    ...(options.session === false ? {} : { sid: 'session' }),
  })
    .setProtectedHeader({ alg: 'RS256', kid: 'test' })
    .setIssuer(options.iss ?? issuer)
    .setAudience(options.aud ?? 'identity-account-api');
  if (options.subject !== false) jwt = jwt.setSubject('owner');
  if (options.exp !== false) jwt = jwt.setExpirationTime('5m');
  return jwt.sign(options.forged ? (await generateKeyPair('RS256')).privateKey : keys.privateKey);
}
const request = (path: string, value?: string, method = 'GET', body?: unknown) =>
  fetch(`${base}${path}`, {
    method,
    headers: {
      ...(value ? { Authorization: `Bearer ${value}` } : {}),
      'Content-Type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
describe('account API authorization boundary', () => {
  it('reuses live roles within /me while checking role changes on every request', async () => {
    client.getUserRealmEffectiveRoles.mockClear();
    client.getUserRealmEffectiveRoles.mockResolvedValueOnce([{ id: 'student', name: 'alumno' }]);
    const headers = { Authorization: `Bearer ${await token()}` };
    const first = await fetch(`${passkeyBase}/v1/account/me`, { headers });
    expect(first.status).toBe(200);
    expect((await first.json()).roles).toEqual(['alumno']);
    expect(client.getUserRealmEffectiveRoles).toHaveBeenCalledTimes(1);
    client.getUserRealmEffectiveRoles.mockResolvedValueOnce([
      { id: 'admin', name: 'administrador' },
    ]);
    expect((await fetch(`${passkeyBase}/v1/account/me`, { headers })).status).toBe(403);
    expect(client.getUserRealmEffectiveRoles).toHaveBeenCalledTimes(2);
    client.getUserRealmEffectiveRoles.mockResolvedValueOnce([
      { id: 'admin', name: 'administrador' },
    ]);
    const verified = await fetch(`${passkeyBase}/v1/account/me`, {
      headers: { Authorization: `Bearer ${await token({ passkey: true })}` },
    });
    expect(verified.status).toBe(200);
    expect((await verified.json()).roles).toEqual(['administrador']);
    expect(client.getUserRealmEffectiveRoles).toHaveBeenCalledTimes(3);
  });
  it('rejects invalid signatures, issuer, audience, missing exp/sub and non-session tokens', async () => {
    expect((await request('/v1/account/me')).status).toBe(401);
    for (const options of [
      { forged: true },
      { iss: 'https://other.test' },
      { aud: 'identity-admin-api' },
      { exp: false },
      { subject: false },
      { session: false },
    ])
      expect((await request('/v1/account/me', await token(options))).status).toBe(401);
  });
  it('serves only projected own data on both API prefixes', async () => {
    for (const prefix of ['/v1', '/api/v1']) {
      const response = await request(`${prefix}/account/me`, await token());
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(await response.json()).toMatchObject({
        id: 'owner',
        roles: ['alumno'],
        permissions: ['analytics:production:access'],
      });
    }
    expect(client.getUser).toHaveBeenCalledWith('owner');
  });
  it('has no administrative endpoints or webhook', async () => {
    for (const path of [
      '/v1/users',
      '/v1/roles',
      '/v1/catalogue',
      '/v1/account/users/other',
      '/webhooks/woocommerce/orders',
    ])
      expect((await request(path, await token())).status).toBe(404);
  });
  it('rate limits email requests without sending beyond the bound', async () => {
    for (let i = 0; i < 5; i++)
      expect((await request('/v1/account/email-verification', await token(), 'POST')).status).toBe(
        204,
      );
    const response = await request('/v1/account/email-verification', await token(), 'POST');
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBeTruthy();
    expect(client.executeActionsEmail).toHaveBeenCalledTimes(5);
  });
  it('retains operational endpoints without exposing personal data', async () => {
    for (const path of ['/health', '/healthcheck', '/ready', '/metrics'])
      expect((await request(path)).status).toBe(200);
  });
});
