import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import { once } from 'node:events';
import type { Server } from 'node:http';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { createAdminAuthenticator } from '../src/oidc-authenticator.js';
import { errorHandler } from '../src/errors.js';
const servers: Server[] = [];
let keys: Awaited<ReturnType<typeof generateKeyPair>>;
let issuer: string;
let base: string;
let currentRoles: string[] = [];
async function listen(app: express.Express) {
  const server = app.listen(0, '127.0.0.1');
  servers.push(server);
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing port');
  return `http://127.0.0.1:${address.port}`;
}
beforeAll(async () => {
  keys = await generateKeyPair('RS256');
  const jwk = await exportJWK(keys.publicKey);
  const authority = express();
  authority.get('/protocol/openid-connect/certs', (_req, res) =>
    res.json({ keys: [{ ...jwk, kid: 'test', alg: 'RS256' }] }),
  );
  issuer = await listen(authority);
  const app = express();
  app.use(
    createAdminAuthenticator({
      issuer,
      audience: 'account',
      requireAdmin: false,
      requireSession: true,
      requireAdministrativePasskey: true,
      effectiveRoles: async () => currentRoles,
    }),
  );
  app.get('/', (_req, res) => res.sendStatus(204));
  app.get('/principal', (_req, res) => res.json(res.locals.principal));
  app.use(errorHandler);
  base = await listen(app);
});
afterAll(async () => {
  await Promise.all(
    servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});
async function request(claims: Record<string, unknown>, path = '/') {
  const token = await new SignJWT({
    realm_access: { roles: ['alumno'] },
    sid: 'session',
    ...claims,
  })
    .setProtectedHeader({ alg: 'RS256', kid: 'test' })
    .setSubject('owner')
    .setIssuer(issuer)
    .setAudience('account')
    .setExpirationTime('5m')
    .sign(keys.privateKey);
  return fetch(base + path, {
    headers: { Authorization: `Bearer ${token}`, 'X-Auth-Time': '9999999999' },
  });
}
describe('signed administrative policy at the API boundary', () => {
  it('projects authentication time and method only from verified claims', async () => {
    currentRoles = [];
    const response = await request(
      { auth_time: 123, tentu_auth_method: 'webauthn-passwordless' },
      '/principal',
    );
    expect(await response.json()).toMatchObject({
      authTime: 123,
      authenticationMethod: 'webauthn-passwordless',
      sessionId: 'session',
    });
    const malformed = await request({ auth_time: '123', tentu_auth_method: true }, '/principal');
    const principal = await malformed.json();
    expect(principal.authTime).toBeUndefined();
    expect(principal.authenticationMethod).toBeUndefined();
  });
  it('allows normal users, rejects previously issued weak tokens after live role assignment and admits attested passkeys', async () => {
    currentRoles = ['alumno'];
    expect((await request({})).status).toBe(204);
    currentRoles = ['administrador'];
    for (const claims of [
      {},
      { tentu_auth_method: 'email-otp', tentu_admin_verified: true },
      { tentu_auth_method: 'otp', tentu_admin_verified: true },
      { tentu_auth_method: 'webauthn-passwordless', tentu_admin_verified: 'true' },
    ])
      expect((await request(claims)).status).toBe(403);
    expect(
      (await request({ tentu_auth_method: 'webauthn-passwordless', tentu_admin_verified: true }))
        .status,
    ).toBe(204);
  });
});

describe('private JWKS transport preserves the public identity boundary', () => {
  it('accepts the canonical issuer and rejects a private transport issuer', async () => {
    const canonicalIssuer = 'https://identity.example.test/realms/tentuplaza';
    const app = express();
    app.use(
      createAdminAuthenticator({
        issuer: canonicalIssuer,
        transportUrl: issuer,
        audience: 'account',
        requireAdmin: false,
      }),
    );
    app.get('/', (_req, res) => res.sendStatus(204));
    app.use(errorHandler);
    const privateBase = await listen(app);
    for (const [tokenIssuer, status] of [
      [canonicalIssuer, 204],
      [issuer, 401],
    ] as const) {
      const token = await new SignJWT({})
        .setProtectedHeader({ alg: 'RS256', kid: 'test' })
        .setSubject('owner')
        .setIssuer(tokenIssuer)
        .setAudience('account')
        .setExpirationTime('5m')
        .sign(keys.privateKey);
      const result = await fetch(privateBase, { headers: { Authorization: `Bearer ${token}` } });
      expect(result.status).toBe(status);
    }
  });
});
