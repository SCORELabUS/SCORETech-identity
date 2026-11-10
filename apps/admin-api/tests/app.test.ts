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
let keys: Awaited<ReturnType<typeof generateKeyPair>>;
const client = {
  listUsers: vi.fn().mockResolvedValue([]),
  createUser: vi.fn(),
  listRealmRoles: vi.fn().mockResolvedValue([]),
  replaceManagedRealmRoles: vi.fn(),
  deleteUser: vi.fn(),
  setPassword: vi.fn(),
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
    { id: 'entry', name: 'admin-web:production:access' },
    { id: 'users', name: 'identity:users:view' },
    { id: 'roles', name: 'identity:roles:view' },
    { id: 'internal', name: 'realm-admin' },
  ]),
  listSessions: vi.fn().mockResolvedValue([{ id: 'boundary-session' }]),
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
    APP_IDENTITY_ENVIRONMENT: 'production',
  });
  base = await listen(
    createApp(config, {
      identityClient: client,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    }),
  );
});
afterAll(async () => {
  await Promise.all(
    servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});
async function token(roles: string[], azp = 'identity-admin-web', audience = 'identity-admin-api') {
  return new SignJWT({
    realm_access: { roles },
    azp,
    sid: 'boundary-session',
    tentu_auth_method: 'webauthn-passwordless',
    tentu_admin_verified: true,
  })
    .setProtectedHeader({ alg: 'RS256', kid: 'test' })
    .setIssuer(issuer)
    .setAudience(audience)
    .setSubject('owner')
    .setExpirationTime('5m')
    .sign(keys.privateKey);
}
const request = (path: string, value: string) =>
  fetch(`${base}${path}`, { headers: { Authorization: `Bearer ${value}` } });
const capabilities = ['admin-web:production:access', 'identity:users:view', 'identity:roles:view'];
describe('administrative app boundary', () => {
  it('admits service access without generic administrator roles and checks client and environment', async () => {
    expect((await request('/v1/users', await token(capabilities))).status).toBe(200);
    expect((await request('/v1/users', await token(['admin-web:production:access']))).status).toBe(
      403,
    );
    for (const roles of [
      ['tech', 'identity-admin:production:access', 'identity:users:view'],
      ['admin'],
      ['admin-web:staging:access', 'identity:users:view'],
    ])
      expect((await request('/v1/users', await token(roles))).status).toBe(403);
    expect((await request('/v1/users', await token(capabilities, 'analytics-web'))).status).toBe(
      403,
    );
    expect(
      (
        await request(
          '/v1/users',
          await token(capabilities, 'identity-admin-web', 'identity-account-api'),
        )
      ).status,
    ).toBe(401);
  });
  it('requires per-operation permissions independently of service entry', async () => {
    expect(
      (
        await request(
          '/v1/users',
          await token(capabilities.filter((role) => role !== 'identity:users:view')),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await request(
          '/v1/roles',
          await token(capabilities.filter((role) => role !== 'identity:roles:view')),
        )
      ).status,
    ).toBe(403);
  });
  it('has retired account endpoints on both prefixes', async () => {
    for (const prefix of ['/v1', '/api/v1'])
      expect((await request(`${prefix}/account/me`, await token(capabilities))).status).toBe(404);
  });
});

it('accepts bounded large application settings before enforcing authentication on both API prefixes', async () => {
  const body = JSON.stringify({
    name: 'Large application',
    kind: 'public',
    origin: 'https://service.example.test',
    enabled: true,
    redirectUris: ['https://service.example.test/callback'],
    postLogoutRedirectUris: [],
    requiredPermissions: Array.from(
      { length: 600 },
      (_, i) => 'service:' + String(i) + ':' + 'a'.repeat(110),
    ),
  });
  for (const prefix of ['/v1', '/api/v1']) {
    const response = await fetch(base + prefix + '/applications', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    expect(response.status).toBe(401);
  }
});
