import { afterEach, expect, it, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import { once } from 'node:events';
import { createInvitationsRouter } from '../src/main/modules/invitations/invitations.routes.js';
import { errorHandler } from '../src/main/shared/http/errors.js';
import { loadConfig } from '../src/main/config/app-config.js';
const id = '11111111-1111-4111-8111-111111111111';
const servers: Server[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});
async function setup(roles: string[]) {
  const config = loadConfig({
    APP_CORS_ORIGINS: 'http://localhost:5173',
    APP_KEYCLOAK_ISSUER: 'https://identity.example.test/realms/test',
    APP_KEYCLOAK_ADMIN_URL: 'http://identity:8080',
    APP_KEYCLOAK_REALM: 'test',
    APP_KEYCLOAK_ADMIN_CLIENT_SECRET: 'fixture',
    APP_IDENTITY_ENVIRONMENT: 'staging',
  });
  const app = express();
  app.use(express.json());
  app.use((_request, response, next) => {
    response.locals.principal = { subject: id, roles };
    next();
  });
  app.use(
    createInvitationsRouter(config, {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    }),
  );
  app.use(errorHandler);
  const server = app.listen(0, '127.0.0.1');
  servers.push(server);
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw Error('No port');
  const originalFetch = globalThis.fetch;
  return (path: string, method = 'GET', body?: unknown) =>
    originalFetch(`http://127.0.0.1:${address.port}${path}`, {
      method,
      headers: { Authorization: 'Bearer fixture', 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
}
it('rejects entry-only access and creation without assignment permission before contacting the provider', async () => {
  const request = await setup(['admin-web:staging:access', 'identity:invitations:create']);
  const fetcher = vi.fn();
  vi.stubGlobal('fetch', fetcher);
  expect(
    (await request('/', 'POST', { name: 'Invitation', roles: ['member'], limit: 3 })).status,
  ).toBe(403);
  expect((await request('/')).status).toBe(403);
  expect(fetcher).not.toHaveBeenCalled();
});
it('validates page, immutable roles and optimistic version before forwarding metadata updates', async () => {
  const request = await setup(['identity:invitations:view', 'identity:invitations:update']);
  const fetcher = vi.fn();
  vi.stubGlobal('fetch', fetcher);
  expect((await request('/?max=101')).status).toBe(400);
  expect((await request(`/${id}`, 'PATCH', { roles: ['admin'], version: 0 })).status).toBe(400);
  expect((await request(`/${id}`, 'PATCH', { name: 'Updated invitation' })).status).toBe(400);
  expect(fetcher).not.toHaveBeenCalled();
});
it('preserves provider conflict and does not expose its response body', async () => {
  const request = await setup(['identity:invitations:revoke']);
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(new Response('private provider details', { status: 409 })),
  );
  const response = await request(`/${id}/revoke`, 'POST');
  expect(response.status).toBe(409);
  expect((await response.json()).error.code).toBe('invitation_conflict');
});

it('reports invalid invitation fields in English before contacting SCORETech Identity', async () => {
  const request = await setup(['identity:invitations:create', 'identity:users:update:roles']);
  const fetcher = vi.fn();
  vi.stubGlobal('fetch', fetcher);
  const response = await request('/', 'POST', { name: '  ', roles: [], limit: 1.5, expiresAt: 1 });
  expect(response.status).toBe(400);
  const { error } = await response.json();
  expect(error.code).toBe('invalid_input');
  expect(error.fields).toEqual({
    name: ['Enter a name.'],
    roles: ['Select at least one role.'],
    limit: ['The registration limit must be an integer.'],
    expiresAt: ['The expiry date must be in the future.'],
  });
  expect(fetcher).not.toHaveBeenCalled();
});

const invitation = {
  id,
  environment: 'staging',
  name: 'Invitation',
  roles: ['administrador'],
  limit: 1,
  completed: 0,
  available: 1,
  creator: id,
  createdAt: Date.now(),
  expiresAt: null,
  revokedAt: null,
  state: 'active',
  version: 0,
};
it.each([undefined, Date.now() + 86400000])(
  'accepts administrator invitations with expiry %s',
  async (expiresAt) => {
    const request = await setup(['identity:invitations:create', 'identity:users:update:roles']);
    const fetcher = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          invitation: { ...invitation, expiresAt: expiresAt ?? null },
          link: `https://identity.example.test/realms/test/tentu-invitations/join#${'x'.repeat(43)}`,
        }),
        { status: 201 },
      ),
    );
    vi.stubGlobal('fetch', fetcher);
    const response = await request('/', 'POST', {
      name: 'Invitation',
      roles: ['administrador'],
      limit: 1,
      ...(expiresAt === undefined ? {} : { expiresAt }),
    });
    expect(response.status).toBe(201);
    expect((await response.json()).invitation.expiresAt).toBe(expiresAt ?? null);
  },
);

it('normalizes null fields omitted by Keycloak on creation, listing and detail', async () => {
  const request = await setup([
    'identity:invitations:create',
    'identity:users:update:roles',
    'identity:invitations:view',
  ]);
  const wireInvitation: Partial<typeof invitation> = { ...invitation };
  delete wireInvitation.expiresAt;
  delete wireInvitation.revokedAt;
  const link = `https://identity.example.test/realms/test/tentu-invitations/join#${'x'.repeat(43)}`;
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ invitation: wireInvitation, link }), { status: 201 }),
    )
    .mockResolvedValueOnce(new Response(JSON.stringify({ invitations: [wireInvitation] })))
    .mockResolvedValueOnce(new Response(JSON.stringify(wireInvitation)));
  vi.stubGlobal('fetch', fetcher);
  const created = await request('/', 'POST', {
    name: invitation.name,
    roles: invitation.roles,
    limit: 1,
  });
  expect(created.status).toBe(201);
  expect((await created.json()).invitation).toMatchObject({ expiresAt: null, revokedAt: null });
  const listed = await request('/', 'GET');
  expect(listed.status).toBe(200);
  expect((await listed.json()).invitations[0]).toMatchObject({ expiresAt: null, revokedAt: null });
  const detail = await request(`/${invitation.id}`, 'GET');
  expect(detail.status).toBe(200);
  expect(await detail.json()).toMatchObject({ expiresAt: null, revokedAt: null });
});

it('does not label a malformed SCORETech Identity response as invalid form input', async () => {
  const request = await setup(['identity:invitations:create', 'identity:users:update:roles']);
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          invitation: { private: 'never expose this value' },
          link: 'invalid',
        }),
        { status: 201 },
      ),
    ),
  );
  const response = await request('/', 'POST', {
    name: 'Invitation',
    roles: ['administrador'],
    limit: 1,
  });
  expect(response.status).toBe(502);
  const body = await response.json();
  expect(body.error.code).toBe('invalid_provider_response');
  expect(body.error.message).toContain('Check the invitation list');
  expect(JSON.stringify(body)).not.toContain('private');
});

it('requires the dedicated delete permission before contacting SCORETech Identity', async () => {
  const request = await setup(['identity:invitations:revoke', 'admin-web:staging:access']);
  const fetcher = vi.fn();
  vi.stubGlobal('fetch', fetcher);
  expect((await request(`/${id}`, 'DELETE')).status).toBe(403);
  expect(fetcher).not.toHaveBeenCalled();
});
it('forwards permanent deletion and accepts an empty provider response', async () => {
  const request = await setup(['identity:invitations:delete']);
  const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
  vi.stubGlobal('fetch', fetcher);
  const response = await request(`/${id}`, 'DELETE');
  expect(response.status).toBe(204);
  expect(await response.text()).toBe('');
  expect(fetcher).toHaveBeenCalledWith(
    expect.stringContaining(`/tentu-invitations/${id}`),
    expect.objectContaining({ method: 'DELETE' }),
  );
});
it('validates delete IDs and preserves not-found responses', async () => {
  const request = await setup(['identity:invitations:delete']);
  const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 404 }));
  vi.stubGlobal('fetch', fetcher);
  expect((await request('/bad-id', 'DELETE')).status).toBe(400);
  expect(fetcher).not.toHaveBeenCalled();
  expect((await request(`/${id}`, 'DELETE')).status).toBe(404);
});

it.each(['ana@example.test', undefined, null])(
  'returns invitation user email %s without losing registration metadata',
  async (email) => {
    const request = await setup(['identity:invitations:view']);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            users: [
              { id, email, registeredAt: 123, roles: ['user'], catalogueRevision: 'revision' },
            ],
          }),
        ),
      ),
    );
    const response = await request(`/${id}/users`);
    expect(response.status).toBe(200);
    expect((await response.json()).users[0]).toEqual({
      id,
      email: email ?? null,
      registeredAt: 123,
      roles: ['user'],
      catalogueRevision: 'revision',
    });
  },
);

it('forwards trimmed invitation search together with its pagination offset', async () => {
  const request = await setup(['identity:invitations:view']);
  const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ invitations: [] })));
  vi.stubGlobal('fetch', fetcher);
  expect((await request('/?first=25&max=25&search=%20Research%20')).status).toBe(200);
  const url = new URL(fetcher.mock.calls[0][0]);
  expect(Object.fromEntries(url.searchParams)).toEqual({
    first: '25',
    max: '25',
    search: 'Research',
  });
  expect((await request('/?search=' + 'x'.repeat(151))).status).toBe(400);
  expect(fetcher).toHaveBeenCalledOnce();
});
