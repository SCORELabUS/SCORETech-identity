import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import express from 'express';
import { once } from 'node:events';
import type { Server } from 'node:http';
import { createAdminAuthenticator } from '../src/main/modules/auth/oidc-authenticator.js';
import { errorHandler } from '../src/main/shared/http/errors.js';
let server: Server;
let issuer: string;
let base: string;
let keys: Awaited<ReturnType<typeof generateKeyPair>>;
const adminEntry = 'admin-web:local:access';
beforeAll(async () => {
  keys = await generateKeyPair('RS256');
  const jwk = await exportJWK(keys.publicKey);
  const app = express();
  app.get('/identity/auth/realms/score/protocol/openid-connect/certs', (_request, response) =>
    response.json({ keys: [{ ...jwk, kid: 'test', alg: 'RS256' }] }),
  );
  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No port');
  base = `http://127.0.0.1:${address.port}`;
  issuer = `${base}/identity/auth/realms/score`;
  app.get(
    '/admin',
    createAdminAuthenticator({
      issuer,
      audience: 'identity-admin-api',
      requireAdmin: false,
      requiredRoles: [adminEntry],
      allowedClients: ['identity-admin-web'],
      requireAdministrativePasskey: false,
    }),
    (_request, response) => response.json(response.locals.principal),
  );
  app.get(
    '/account',
    createAdminAuthenticator({
      issuer,
      audience: 'identity-account-api',
      requireAdmin: false,
      requireAdministrativePasskey: false,
    }),
    (_request, response) => response.json(response.locals.principal),
  );
  app.use(errorHandler);
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
async function token(
  audience: string,
  roles: string[],
  options: { issuer?: string; expires?: string; subject?: string; clientId?: string } = {},
) {
  return new SignJWT({
    realm_access: { roles },
    azp:
      options.clientId ??
      (audience === 'identity-admin-api' ? 'identity-admin-web' : 'identity-account-web'),
  })
    .setProtectedHeader({ alg: 'RS256', kid: 'test' })
    .setIssuer(options.issuer ?? issuer)
    .setAudience(audience)
    .setSubject(options.subject ?? 'test-user')
    .setIssuedAt()
    .setExpirationTime(options.expires ?? '5m')
    .sign(keys.privateKey);
}
const request = (path: string, token?: string) =>
  fetch(`${base}${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
describe('OIDC boundaries', () => {
  it('rejects missing, malformed and expired tokens', async () => {
    expect((await request('/account')).status).toBe(401);
    expect((await request('/account', 'forged')).status).toBe(401);
    expect(
      (await request('/account', await token('identity-account-api', [], { expires: '-1m' })))
        .status,
    ).toBe(401);
  });
  it('rejects the wrong issuer or audience', async () => {
    expect((await request('/account', await token('identity-admin-api', ['admin']))).status).toBe(
      401,
    );
    expect(
      (
        await request(
          '/account',
          await token('identity-account-api', [], { issuer: 'https://other.example.test' }),
        )
      ).status,
    ).toBe(401);
  });
  it('allows personal access without an admin role and blocks administrative access', async () => {
    expect(
      (await request('/account', await token('identity-account-api', ['member']))).status,
    ).toBe(200);
    expect((await request('/admin', await token('identity-admin-api', ['member']))).status).toBe(
      403,
    );
    expect((await request('/admin', await token('identity-admin-api', ['admin']))).status).toBe(
      403,
    );
    expect(
      (await request('/admin', await token('identity-admin-api', ['administrador']))).status,
    ).toBe(403);
    expect((await request('/admin', await token('identity-admin-api', [adminEntry]))).status).toBe(
      200,
    );
  });
  it('rejects another environment and an unapproved client despite an administrative audience', async () => {
    expect(
      (await request('/admin', await token('identity-admin-api', ['admin-web:staging:access'])))
        .status,
    ).toBe(403);
    expect(
      (
        await request(
          '/admin',
          await token('identity-admin-api', [adminEntry], { clientId: 'identity-account-web' }),
        )
      ).status,
    ).toBe(403);
  });
});
