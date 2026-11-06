import { describe, it, expect, vi } from 'vitest';
import { createAccountClient } from '../src/account-client.js';
import { KeycloakAdminClient } from '../src/keycloak-client.js';
describe('restricted account adapter', () => {
  it('reads validated user data and performs a narrow exact-email ownership lookup', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: 'token', expires_in: 300 })),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: 'owner', enabled: true, emailVerified: false })),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            { id: 'owner', email: 'owner@example.test', enabled: true, emailVerified: true },
          ]),
        ),
      );
    const client = createAccountClient({
      issuer: 'https://identity.test/realms/test',
      adminUrl: 'https://identity.test',
      realm: 'test',
      clientId: 'identity-account-service',
      clientSecret: 'fixture',
      fetchImplementation: fetcher,
    });
    expect(await client.getUser('owner')).toMatchObject({ id: 'owner' });
    expect(await client.findUsersByEmail('owner@example.test')).toEqual([
      { id: 'owner', email: 'owner@example.test' },
    ]);
    for (const operation of [
      'createUser',
      'deleteUser',
      'setPassword',
      'replaceManagedRealmRoles',
      'listUsers',
    ])
      expect(operation in client).toBe(false);
    expect(String(fetcher.mock.calls[1][0]).endsWith('/users/owner')).toBe(true);
    expect(fetcher.mock.calls[0][0]).toBe(
      'https://identity.test/realms/test/protocol/openid-connect/token',
    );
    expect(fetcher.mock.calls[1][0]).toBe('https://identity.test/admin/realms/test/users/owner');
    const query = new URL(String(fetcher.mock.calls[2]?.[0])).searchParams;
    expect(query.get('email')).toBe('owner@example.test');
    expect(query.get('exact')).toBe('true');
  });
  it('uses the private realm transport for tokens and custom resources independently of Admin REST', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: 'token', expires_in: 300 })),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: 'owner', enabled: true, emailVerified: true })),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ recovery: null })))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const options = {
      issuer: 'https://identity.test/realms/test',
      transportUrl: 'http://identity-provider.prod-platform.svc:8080/realms/test/',
      adminUrl: 'http://identity-admin.prod-platform.svc:8080/',
      realm: 'test',
      clientId: 'identity-account-service',
      clientSecret: 'fixture',
      fetchImplementation: fetcher,
    };
    const client = new KeycloakAdminClient(options);
    await client.getUser('owner');
    await client.updateUser('owner', { firstName: 'Updated' });
    await client.recoveryStatus('owner', 'user-token');
    await client.reserveVerification('owner', 'user-token');
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
      'http://identity-provider.prod-platform.svc:8080/realms/test/protocol/openid-connect/token',
      'http://identity-admin.prod-platform.svc:8080/admin/realms/test/users/owner',
      'http://identity-provider.prod-platform.svc:8080/realms/test/tentu-user-mutations/users/owner',
      'http://identity-provider.prod-platform.svc:8080/realms/test/tentu-recovery/users/owner',
      'http://identity-provider.prod-platform.svc:8080/realms/test/tentu-support/users/owner/verification-request',
    ]);
    expect(options.issuer).toBe('https://identity.test/realms/test');
    expect(fetcher.mock.calls[3][1]?.headers).toMatchObject({
      Authorization: 'Bearer user-token',
    });
  });
});
