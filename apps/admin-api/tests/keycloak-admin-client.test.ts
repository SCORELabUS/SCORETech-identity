import { describe, expect, it, vi } from 'vitest';
import { KeycloakAdminClient } from '../src/main/modules/identity/keycloak-admin-client.js';

const userId = 'e8d3f9f9-36dd-4ca3-b08f-03e3b4dc4f48';

describe('KeycloakAdminClient', () => {
  it('uses a service token and returns only managed realm roles', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ access_token: 'service-token', expires_in: 300 }))
      .mockResolvedValueOnce(
        jsonResponse([
          { id: 'role-admin', name: 'admin' },
          { id: 'role-user', name: 'user' },
          { id: 'role-other', name: 'realm-admin' },
        ]),
      );
    const client = createClient(request);

    await expect(client.listRealmRoles()).resolves.toEqual([
      { id: 'role-admin', name: 'admin' },
      { id: 'role-user', name: 'user' },
    ]);
    expect(request).toHaveBeenNthCalledWith(
      1,
      'https://identity.example.test/realms/tentuplaza/protocol/openid-connect/token',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(request).toHaveBeenNthCalledWith(
      2,
      'http://identity-provider:8080/admin/realms/tentuplaza/roles',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer service-token' }),
      }),
    );
  });

  it('replaces only the roles managed by the first administrative release', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ access_token: 'service-token', expires_in: 300 }))
      .mockResolvedValueOnce(
        jsonResponse([
          { id: 'role-admin', name: 'admin' },
          { id: 'role-user', name: 'user' },
        ]),
      )
      .mockResolvedValueOnce(
        jsonResponse([
          { id: 'role-user', name: 'user' },
          { id: 'role-other', name: 'future:read' },
        ]),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const client = createClient(request);

    await client.replaceManagedRealmRoles(userId, ['admin']);

    expect(request).toHaveBeenNthCalledWith(
      5,
      `http://identity-provider:8080/admin/realms/tentuplaza/users/${userId}/role-mappings/realm`,
      expect.objectContaining({
        method: 'DELETE',
        body: JSON.stringify([{ id: 'role-user', name: 'user' }]),
      }),
    );
    expect(request).toHaveBeenNthCalledWith(
      4,
      `http://identity-provider:8080/admin/realms/tentuplaza/users/${userId}/role-mappings/realm`,
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify([{ id: 'role-admin', name: 'admin' }]),
      }),
    );
  });
});

const createClient = (fetchImplementation: typeof fetch): KeycloakAdminClient =>
  new KeycloakAdminClient({
    issuer: 'https://identity.example.test/realms/tentuplaza',
    adminUrl: 'http://identity-provider:8080',
    realm: 'tentuplaza',
    clientId: 'identity-admin-service',
    clientSecret: 'not-a-real-secret',
    fetchImplementation,
  });

const jsonResponse = (payload: unknown): Response =>
  new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });

describe('additional provider operations', () => {
  it('sets a temporary password and deletes a user through typed administrative endpoints', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ access_token: 'token', expires_in: 300 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const client = createClient(request);
    await client.setPassword(userId, 'long-temporary-password');
    await client.deleteUser(userId);
    expect(request.mock.calls[1][0]).toContain('/reset-password');
    expect(JSON.parse(request.mock.calls[1][1]?.body as string)).toEqual({
      type: 'password',
      value: 'long-temporary-password',
      temporary: true,
    });
    expect(request.mock.calls[2][1]?.method).toBe('DELETE');
  });
  it('sends only requested mutations without reading or resending stale administrative fields', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ access_token: 'token', expires_in: 300 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const patch = { email: 'new@example.test', attributes: { tentuAvatar: ['forest'] } };
    await createClient(request).updateUser(userId, patch);
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[1][0]).toContain(`/tentu-user-mutations/users/${userId}`);
    expect(request.mock.calls[1][1]?.method).toBe('PATCH');
    expect(JSON.parse(request.mock.calls[1][1]?.body as string)).toEqual(patch);
  });
  it('validates sessions and encodes user IDs', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ access_token: 'token', expires_in: 300 }))
      .mockResolvedValueOnce(jsonResponse([{ id: 'session', start: 1, lastAccess: 2 }]))
      .mockResolvedValueOnce(jsonResponse([{ id: 'bad' }]));
    const client = createClient(request);
    expect(await client.listSessions('user/id')).toHaveLength(1);
    expect(request.mock.calls[1][0]).toContain('user%2Fid/sessions');
    await expect(client.listSessions('id')).rejects.toThrow();
  });
  it('revokes only a session that belongs to the authenticated user', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ access_token: 'token', expires_in: 300 }))
      .mockResolvedValueOnce(jsonResponse([{ id: 'session', start: 1, lastAccess: 2 }]))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    await createClient(request).logoutSession('user/id', 'session');
    expect(request.mock.calls[1][0]).toContain('user%2Fid/sessions');
    expect(request.mock.calls[2][0]).toContain('/sessions/session');
    expect(request.mock.calls[2][1]?.method).toBe('DELETE');
  });
  it('does not accept an unapproved role or delete existing access when an addition fails', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ access_token: 'token', expires_in: 300 }))
      .mockResolvedValueOnce(jsonResponse([{ id: 'admin', name: 'admin' }]))
      .mockResolvedValueOnce(jsonResponse([{ id: 'user', name: 'user' }]))
      .mockResolvedValueOnce(new Response(null, { status: 500 }));
    const client = createClient(request);
    await expect(client.replaceManagedRealmRoles(userId, ['realm-admin'])).rejects.toMatchObject({
      status: 400,
    });
    expect(request).not.toHaveBeenCalled();
    await expect(client.replaceManagedRealmRoles(userId, ['admin'])).rejects.toMatchObject({
      status: 502,
    });
    expect(request.mock.calls.some((call) => call[1]?.method === 'DELETE')).toBe(false);
  });
});

describe('directory filters and activation', () => {
  it('combines name, role and status before paginating across role pages', async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => ({
      id: `id-${index}`,
      username: `other-${index}`,
      enabled: true,
      emailVerified: true,
    }));
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ access_token: 'token', expires_in: 300 }))
      .mockResolvedValueOnce(jsonResponse(firstPage))
      .mockResolvedValueOnce(
        jsonResponse([
          {
            id: 'excluded',
            firstName: 'Ana',
            lastName: 'García',
            enabled: false,
            emailVerified: true,
          },
          { id: 'match', firstName: 'Ana', lastName: 'García', enabled: true, emailVerified: true },
        ]),
      );
    await expect(
      createClient(request).listUsers('ana garcia', 0, 25, {
        role: 'admin',
        enabled: true,
        emailVerified: true,
      }),
    ).resolves.toMatchObject([{ id: 'match' }]);
    expect(request.mock.calls[2][0]).toContain('first=100');
  });
  it('requests a bounded, client-bound activation link from Keycloak', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ access_token: 'token', expires_in: 300 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    await createClient(request).executeActionsEmail(userId, ['VERIFY_EMAIL', 'UPDATE_PASSWORD'], {
      lifespan: 3600,
      clientId: 'identity-account-web',
      redirectUri: 'https://id.example.test',
    });
    const url = new URL(String(request.mock.calls[1][0]));
    expect(url.searchParams.get('lifespan')).toBe('3600');
    expect(url.searchParams.get('client_id')).toBe('identity-account-web');
    expect(url.searchParams.get('redirect_uri')).toBe('https://id.example.test');
  });
});

describe('account session isolation', () => {
  it('refuses a foreign session without issuing a DELETE', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ access_token: 'token', expires_in: 300 }))
      .mockResolvedValueOnce(jsonResponse([{ id: 'own', start: 1, lastAccess: 2 }]));
    await expect(createClient(request).logoutSession(userId, 'foreign')).rejects.toMatchObject({
      status: 404,
    });
    expect(request.mock.calls.some((call) => call[1]?.method === 'DELETE')).toBe(false);
  });
});
