import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { once } from 'node:events';
import type { Server } from 'node:http';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { createAdminAuthenticator } from '../src/oidc-authenticator.js';
import { errorHandler } from '../src/errors.js';

const entry = 'admin-web:local:access';
const view = 'identity:users:view';
const issuer = 'https://identity.example.test/identity/auth/realms/score';
const subject = '11111111-1111-4111-8111-111111111111';
const servers: Server[] = [];
let keys: Awaited<ReturnType<typeof generateKeyPair>>;
let untrustedKeys: Awaited<ReturnType<typeof generateKeyPair>>;
let base: string;
let liveRoles: string[];
const resolveRoles = vi.fn(async () => [...liveRoles]);

async function listen(app: express.Express): Promise<string> {
  const server = app.listen(0, '127.0.0.1');
  servers.push(server);
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing test server port.');
  return `http://127.0.0.1:${address.port}`;
}

beforeAll(async () => {
  keys = await generateKeyPair('RS256');
  untrustedKeys = await generateKeyPair('RS256');
  const publicKey = await exportJWK(keys.publicKey);
  const authority = express();
  authority.get('/identity/auth/realms/score/protocol/openid-connect/certs', (_request, response) =>
    response.json({ keys: [{ ...publicKey, kid: 'score-passkey-test', alg: 'RS256' }] }),
  );
  const transport = (await listen(authority)) + '/identity/auth/realms/score';
  const app = express();
  const middleware = (account: boolean) =>
    createAdminAuthenticator({
      issuer,
      transportUrl: transport,
      audience: account ? 'identity-account-api' : 'identity-admin-api',
      requireAdmin: false,
      requireSession: true,
      requiredRoles: account ? [] : [entry],
      allowedClients: [account ? 'identity-account-web' : 'identity-admin-web'],
      requireAdministrativePasskey: true,
      effectiveRoles: resolveRoles,
    });
  app.get('/admin', middleware(false), (_request, response) =>
    response.json(response.locals.principal),
  );
  app.get('/account', middleware(true), (_request, response) =>
    response.json(response.locals.principal),
  );
  app.use(errorHandler);
  base = await listen(app);
});

beforeEach(() => {
  liveRoles = [entry, view];
  resolveRoles.mockClear();
});

afterAll(async () => {
  await Promise.all(
    servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

async function request(
  claims: Record<string, unknown>,
  options: {
    account?: boolean;
    untrustedSignature?: boolean;
    headers?: Record<string, string>;
  } = {},
) {
  const token = await new SignJWT({
    realm_access: { roles: options.account ? ['member'] : [entry, view] },
    sid: 'fixture-session',
    azp: options.account ? 'identity-account-web' : 'identity-admin-web',
    ...claims,
  })
    .setProtectedHeader({ alg: 'RS256', kid: 'score-passkey-test' })
    .setSubject(subject)
    .setIssuer(issuer)
    .setAudience(options.account ? 'identity-account-api' : 'identity-admin-api')
    .setExpirationTime('5m')
    .sign((options.untrustedSignature ? untrustedKeys : keys).privateKey);
  return fetch(base + (options.account ? '/account' : '/admin'), {
    headers: { Authorization: `Bearer ${token}`, ...options.headers },
  });
}

describe('passkeys for delegated SCORE administrators', () => {
  it.each(['email-otp', 'otp', 'totp'])(
    'rejects %s even with a signed administrative verification flag',
    async (method) => {
      const response = await request({ tentu_auth_method: method, tentu_admin_verified: true });
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({
        error: { code: 'administrative_passkey_required' },
      });
      expect(resolveRoles).toHaveBeenCalledWith(subject);
    },
  );

  it.each([
    {},
    { tentu_auth_method: 'webauthn-passwordless' },
    { tentu_admin_verified: true },
    { tentu_auth_method: 'webauthn-passwordless', tentu_admin_verified: 'true' },
  ])('rejects missing or malformed passkey proof: %j', async (proof) => {
    expect((await request(proof)).status).toBe(403);
  });

  it('permits server-signed passkey proof without requiring the protected administrator role', async () => {
    const response = await request({
      tentu_auth_method: 'webauthn-passwordless',
      tentu_admin_verified: true,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      subject,
      authenticationMethod: 'webauthn-passwordless',
      roles: [entry, view],
      effectiveRoleNames: [entry, view],
    });
    expect(liveRoles).not.toContain('administrador');
  });

  it('rechecks live permissions when an ordinary existing session gains administrative access', async () => {
    liveRoles = ['member'];
    expect((await request({ tentu_auth_method: 'email-otp' }, { account: true })).status).toBe(200);
    liveRoles = ['member', entry, view];
    expect((await request({ tentu_auth_method: 'email-otp' }, { account: true })).status).toBe(403);
    expect(resolveRoles).toHaveBeenCalledTimes(2);
  });

  it('ignores caller-supplied headers that claim passkey verification', async () => {
    const response = await request(
      { tentu_auth_method: 'email-otp' },
      {
        headers: { 'X-Auth-Method': 'webauthn-passwordless', 'X-Admin-Verified': 'true' },
      },
    );
    expect(response.status).toBe(403);
  });

  it('rejects passkey claims signed by a key outside the issuer JWKS', async () => {
    const response = await request(
      { tentu_auth_method: 'webauthn-passwordless', tentu_admin_verified: true },
      { untrustedSignature: true },
    );
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: { code: 'invalid_token' } });
    expect(resolveRoles).not.toHaveBeenCalled();
  });
});
