import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import { once } from 'node:events';
import { createAccountRouter } from '../src/main/modules/account/account.routes.js';
import { errorHandler, HttpError } from '@scoretech/identity-internal';
import { loadConfig } from '../src/main/config/app-config.js';
import { AvatarStorage } from '../src/main/modules/account/avatar-storage.js';

const actor = '11111111-1111-4111-8111-111111111111';
const target = '22222222-2222-4222-8222-222222222222';
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
  vi.restoreAllMocks();
});
export const config = loadConfig({
  APP_REQUIRE_ADMIN_PASSKEY: 'false',
  APP_CORS_ORIGINS: 'http://localhost:5173',
  APP_KEYCLOAK_ISSUER: 'https://identity.example.test/identity/auth/realms/score',
  APP_KEYCLOAK_ADMIN_URL: 'http://identity:8080',
  APP_KEYCLOAK_REALM: 'score',
  APP_KEYCLOAK_ADMIN_CLIENT_SECRET: 'test-secret',
  APP_ACCOUNT_PUBLIC_URL: 'https://id.example.test/identity/account/',
});
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
const makeClient = () => ({
  listCredentials: vi.fn().mockResolvedValue([]),
  listUsers: vi.fn().mockResolvedValue([]),
  findUsersByEmail: vi.fn().mockResolvedValue([]),
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
  listSessions: vi.fn().mockResolvedValue([]),
  listSecurityEvents: vi.fn().mockResolvedValue({ enabled: true, events: [], first: 0, max: 100 }),
});
async function setup(
  authorizationCatalogue?: () => Promise<{ permissions: string[]; roles: string[] }>,
  overrides: Partial<ReturnType<typeof loadConfig>> = {},
) {
  const client = makeClient();
  const app = express();
  app.use(express.json());
  app.use((_req, res, next) => {
    res.locals.principal = { subject: actor, sessionId: 'own-session', roles: [] };
    next();
  });
  app.use(createAccountRouter(client, { ...config, ...overrides }, logger, authorizationCatalogue));
  app.use(errorHandler);
  const server = app.listen(0, '127.0.0.1');
  servers.push(server);
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No port');
  const request = (
    path: string,
    method = 'GET',
    body?: unknown,
    headers: Record<string, string> = {},
  ) =>
    fetch(`http://127.0.0.1:${address.port}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  return { client, request };
}
describe('self-service isolation', () => {
  it('does not expose commerce, purchase-email lookup or legal endpoints', async () => {
    const { client, request } = await setup();
    expect((await request('/payments')).status).toBe(404);
    expect(
      (await request('/email-claim-check', 'POST', { email: 'orders@example.test' })).status,
    ).toBe(404);
    expect((await request('/legal')).status).toBe(404);
    expect(client.findUsersByEmail).not.toHaveBeenCalled();
    expect(client.getUser).not.toHaveBeenCalled();
  });

  it('rejects another user scope and non-allowlisted origins before contacting the provider', async () => {
    const { request } = await setup();
    expect(
      (
        await request('/step-up', 'POST', {
          scope: 'user:target:credentials',
          origin: 'http://localhost:5173',
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await request('/step-up', 'POST', {
          scope: 'self:security',
          origin: 'https://evil.example',
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await request('/step-up', 'POST', {
          scope: 'self:security',
          origin: 'http://localhost:5173',
          userId: target,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await request('/step-up', 'POST', {
          scope: 'self:security',
          origin: 'http://localhost:5173',
        })
      ).status,
    ).toBe(401);
  });

  it('projects real credentials and stores suggestion presentation for the verified owner', async () => {
    const { request, client } = await setup();
    expect(await (await request('/security')).json()).toMatchObject({
      suggestPasskey: true,
      passkeys: [],
      totp: [],
    });
    expect(client.listCredentials).toHaveBeenCalledWith(actor);
    client.listCredentials.mockResolvedValue([
      {
        id: 'key',
        type: 'webauthn-passwordless',
        userLabel: 'Security key',
        secretData: 'never-return',
      },
    ] as never);
    const security = await (await request('/security')).json();
    expect(security.suggestPasskey).toBe(false);
    expect(security.passkeys).toEqual([{ id: 'key', label: 'Security key' }]);
    expect((await request('/security/passkey-suggestion', 'POST', { userId: target })).status).toBe(
      204,
    );
    expect(client.updateUser).toHaveBeenCalledWith(actor, {
      attributes: { tentuPasskeySuggestionSeen: ['true'] },
    });
    client.listCredentials.mockResolvedValue([]);
    client.getUser.mockResolvedValue({
      id: actor,
      email: 'test@example.test',
      emailVerified: true,
      enabled: true,
      attributes: { tentuPasskeySuggestionSeen: ['true'] },
    } as never);
    expect((await (await request('/security')).json()).suggestPasskey).toBe(false);
    client.getUserRealmEffectiveRoles.mockResolvedValue([
      { id: 'role', name: 'administrador' },
    ] as never);
    expect((await (await request('/security')).json()).administrator).toBe(true);
  });

  it('never returns private Keycloak attributes', async () => {
    const { request, client } = await setup();
    const response = await request('/me');
    const profile = await response.json();
    expect(client.getUser).toHaveBeenCalledWith(actor);
    expect(profile.avatar).toEqual({
      kind: 'initials',
      backgroundColor: 'stone',
      foregroundColor: 'graphite',
    });
    expect(profile.roles).toEqual([]);
    expect(profile.permissions).toEqual([]);
    expect(profile.attributes).toBeUndefined();
  });
  it('rejects role, identity, email and commerce attribute injection', async () => {
    const { request, client } = await setup();
    for (const extra of [
      { roles: [] },
      { id: target },
      { email: 'other@example.test' },
      { attributes: { tentuWooCustomerId: ['123'] } },
    ]) {
      expect(
        (
          await request('/me', 'PATCH', {
            firstName: 'Ana',
            lastName: 'García',
            avatar: { kind: 'initials', backgroundColor: 'paper', foregroundColor: 'graphite' },
            ...extra,
          })
        ).status,
      ).toBe(400);
    }
    expect(client.updateUser).not.toHaveBeenCalled();
  });
  it('updates only the authenticated account and explicitly allowed attributes', async () => {
    const { request, client } = await setup();
    expect(
      (
        await request('/me', 'PATCH', {
          firstName: 'Ana',
          lastName: 'García',
          avatar: { kind: 'initials', backgroundColor: 'paper', foregroundColor: 'graphite' },
        })
      ).status,
    ).toBe(204);
    expect(client.updateUser).toHaveBeenCalledWith(actor, {
      firstName: 'Ana',
      lastName: 'García',
      attributes: {
        tentuAvatar: [
          JSON.stringify({
            kind: 'initials',
            backgroundColor: 'paper',
            foregroundColor: 'graphite',
          }),
        ],
        tentuUpdatedAt: expect.any(Array),
      },
    });
    expect((await request(`/users/${target}`)).status).toBe(404);
  });
  it('rejects fiscal metadata even when the supplied document is valid', async () => {
    const { request, client } = await setup();
    for (const excluded of [
      { taxDocumentType: 'DNI' },
      { taxDocumentNumber: '12345678Z' },
      { taxDocumentType: 'DNI', taxDocumentNumber: '12345678Z' },
      { marketing: true },
    ]) {
      const response = await request('/me', 'PATCH', {
        firstName: 'Ana',
        lastName: 'García',
        avatar: { kind: 'initials', backgroundColor: 'paper', foregroundColor: 'graphite' },
        ...excluded,
      });
      expect(response.status).toBe(400);
    }
    expect(client.updateUser).not.toHaveBeenCalled();
  });
  it('patches phone only when explicitly supplied and never restores administrative state', async () => {
    const { request, client } = await setup();
    client.getUser.mockResolvedValue({
      id: actor,
      email: 'test@example.test',
      emailVerified: true,
      enabled: false,
      attributes: { private: ['protected'], tentuPhone: ['+34600000000'] },
    });
    const profile = {
      firstName: 'Ana',
      lastName: 'García',
      avatar: { kind: 'initials', backgroundColor: 'paper', foregroundColor: 'graphite' },
    };
    expect((await request('/me', 'PATCH', profile)).status).toBe(204);
    const omittedPhone = client.updateUser.mock.calls[0]![1];
    expect(omittedPhone).not.toHaveProperty('enabled');
    expect(omittedPhone).not.toHaveProperty('emailVerified');
    expect(omittedPhone.attributes).not.toHaveProperty('private');
    expect(omittedPhone.attributes).not.toHaveProperty('tentuPhone');
    expect((await request('/me', 'PATCH', { ...profile, phone: '+34611111111' })).status).toBe(204);
    expect(client.updateUser.mock.calls[1]![1].attributes.tentuPhone).toEqual(['+34611111111']);
    expect((await request('/me', 'PATCH', { ...profile, phone: '' })).status).toBe(204);
    expect(client.updateUser.mock.calls[2]![1].attributes.tentuPhone).toEqual([]);
  });

  it('preserves a stored photo when a profile patch omits the avatar', async () => {
    const assertOwnedImage = vi
      .spyOn(AvatarStorage.prototype, 'assertOwnedImage')
      .mockResolvedValue();
    const deleteImage = vi.spyOn(AvatarStorage.prototype, 'delete').mockResolvedValue();
    const { request, client } = await setup(undefined, { APP_AVATAR_BUCKET: 'test-avatars' });
    client.getUser.mockResolvedValue({
      id: actor,
      email: 'test@example.test',
      emailVerified: true,
      enabled: true,
      attributes: {
        tentuAvatar: [JSON.stringify({ kind: 'photo', imageKey: `avatars/${actor}/photo.jpg` })],
      },
    });

    expect((await request('/me', 'PATCH', { firstName: 'Ana', lastName: 'García' })).status).toBe(
      204,
    );
    expect(client.updateUser).toHaveBeenCalledWith(actor, {
      firstName: 'Ana',
      lastName: 'García',
      attributes: { tentuUpdatedAt: expect.any(Array) },
    });
    expect(client.getUser).not.toHaveBeenCalled();
    expect(assertOwnedImage).not.toHaveBeenCalled();
    expect(deleteImage).not.toHaveBeenCalled();
  });

  it('still validates explicit avatars and verifies photo ownership before updating', async () => {
    const assertOwnedImage = vi
      .spyOn(AvatarStorage.prototype, 'assertOwnedImage')
      .mockRejectedValue(
        new HttpError(400, 'invalid_avatar_image', 'Image ownership could not be verified.'),
      );
    const deleteImage = vi.spyOn(AvatarStorage.prototype, 'delete').mockResolvedValue();
    const { request, client } = await setup(undefined, { APP_AVATAR_BUCKET: 'test-avatars' });
    const profile = { firstName: 'Ana', lastName: 'García' };

    expect((await request('/me', 'PATCH', { ...profile, avatar: null })).status).toBe(400);
    expect(
      (await request('/me', 'PATCH', { ...profile, avatar: { kind: 'unknown' } })).status,
    ).toBe(400);
    expect(assertOwnedImage).not.toHaveBeenCalled();
    const avatar = { kind: 'photo', imageKey: `avatars/${actor}/photo.jpg` };
    expect((await request('/me', 'PATCH', { ...profile, avatar })).status).toBe(400);
    expect(assertOwnedImage).toHaveBeenCalledWith(actor, avatar.imageKey);
    expect(client.updateUser).not.toHaveBeenCalled();
    expect(deleteImage).not.toHaveBeenCalled();
  });

  it('deletes the previous owned photo only after an explicit avatar replacement succeeds', async () => {
    const assertOwnedImage = vi
      .spyOn(AvatarStorage.prototype, 'assertOwnedImage')
      .mockResolvedValue();
    const deleteImage = vi.spyOn(AvatarStorage.prototype, 'delete').mockResolvedValue();
    const { request, client } = await setup(undefined, { APP_AVATAR_BUCKET: 'test-avatars' });
    const oldKey = `avatars/${actor}/photo.jpg`;
    client.getUser.mockResolvedValue({
      id: actor,
      email: 'test@example.test',
      emailVerified: true,
      enabled: true,
      attributes: { tentuAvatar: [JSON.stringify({ kind: 'photo', imageKey: oldKey })] },
    });
    const avatar = { kind: 'initials', backgroundColor: 'paper', foregroundColor: 'graphite' };
    client.updateUser.mockRejectedValueOnce(new Error('Provider write failed.'));
    const profile = { firstName: 'Ana', lastName: 'García', avatar };

    expect((await request('/me', 'PATCH', profile)).status).toBe(500);
    expect(deleteImage).not.toHaveBeenCalled();
    expect((await request('/me', 'PATCH', profile)).status).toBe(204);
    expect(client.updateUser).toHaveBeenLastCalledWith(actor, {
      firstName: 'Ana',
      lastName: 'García',
      attributes: { tentuAvatar: [JSON.stringify(avatar)], tentuUpdatedAt: expect.any(Array) },
    });
    expect(deleteImage).toHaveBeenCalledOnce();
    expect(deleteImage).toHaveBeenCalledWith(oldKey);
    expect(assertOwnedImage).not.toHaveBeenCalled();
  });

  it('exposes published catalogue roles and effective permissions separately', async () => {
    const { client, request } = await setup(async () => ({
      permissions: ['identity:users:view'],
      roles: ['administrador', 'researcher', 'member'],
    }));
    client.getUserRealmEffectiveRoles.mockResolvedValue([
      { id: 'admin', name: 'admin' },
      { id: 'default', name: 'default-roles-score' },
      { id: 'student', name: 'researcher' },
      { id: 'users-read', name: 'identity:users:view' },
    ]);

    const response = await request('/me');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      permissions: ['identity:users:view'],
      roles: ['administrador', 'researcher'],
    });
  });
  it('can revoke one owned session and send a verification email without exposing account administration', async () => {
    const { request, client } = await setup();
    expect((await request('/sessions/current-device', 'DELETE')).status).toBe(204);
    expect(client.logoutSession).toHaveBeenCalledWith(actor, 'current-device');
    expect((await request('/email-verification', 'POST')).status).toBe(204);
    expect(client.executeActionsEmail).toHaveBeenCalledWith(
      actor,
      ['VERIFY_EMAIL'],
      expect.objectContaining({ clientId: 'identity-account-web' }),
    );
  });
});

describe('session activity isolation', () => {
  it('marks current session from the verified sid and projects its browser', async () => {
    const { request, client } = await setup();
    client.listSessions.mockResolvedValue([
      { id: 'own-session', start: 1, lastAccess: 2 },
    ] as never);
    const result = await (await request('/sessions')).json();
    expect(result.sessions[0]).toMatchObject({ current: true });
    expect(client.listSecurityEvents).toHaveBeenCalledWith({ user: actor, max: 100 });
  });
  it('rejects another account session before fetching events', async () => {
    const { request, client } = await setup();
    expect((await request('/sessions/foreign-session/activity')).status).toBe(404);
    expect(client.listSecurityEvents).not.toHaveBeenCalled();
  });
  it('returns only events for the authenticated owner and selected session', async () => {
    const { request, client } = await setup();
    client.listSessions.mockResolvedValue([
      { id: 'own-session', start: 1, lastAccess: 2, clients: { id: 'identity-account-web' } },
    ] as never);
    client.listSecurityEvents.mockResolvedValue({
      enabled: true,
      first: 0,
      max: 100,
      events: [
        { time: 1, type: 'LOGIN', userId: actor, sessionId: 'own-session' },
        { time: 2, type: 'LOGIN', userId: target, sessionId: 'own-session' },
        { time: 3, type: 'LOGIN', userId: actor, sessionId: 'another-session' },
      ],
    } as never);
    const result = await (await request('/sessions/own-session/activity')).json();
    expect(result.events).toHaveLength(1);
    expect(result.applications).toEqual(['identity-account-web']);
    expect(client.listSecurityEvents).toHaveBeenCalledWith({ user: actor, first: 0, max: 100 });
  });
});

describe('account appearance preferences', () => {
  it('defaults missing appearance and persists only the authenticated subject', async () => {
    const { client, request } = await setup();
    expect(await (await request('/preferences')).json()).toEqual({ theme: 'light' });
    expect(client.getUser).toHaveBeenCalledWith(actor);
    expect((await request('/preferences', 'PUT', { theme: 'dark' })).status).toBe(204);
    expect(client.updateUser).toHaveBeenCalledWith(actor, {
      attributes: { tentuPreferences: [JSON.stringify({ theme: 'dark' })] },
    });
  });
  it('rejects arbitrary subjects, invalid themes and excluded commercial settings', async () => {
    const { client, request } = await setup();
    for (const value of [
      { theme: 'dark', userId: target },
      { theme: 'invalid' },
      { theme: true },
      { theme: 'dark', email: true },
      { theme: 'dark', boe: true },
      { theme: 'dark', notifications: { commercial: true } },
      { theme: 'dark', communicationChannels: {} },
      { theme: 'dark', marketing: true },
      {},
    ]) {
      expect((await request('/preferences', 'PUT', value)).status).toBe(400);
    }
    expect(client.updateUser).not.toHaveBeenCalled();
  });
  it('returns saved appearance without exposing other identity attributes', async () => {
    const { client, request } = await setup();
    client.getUser.mockResolvedValueOnce({
      id: actor,
      email: 'test@example.test',
      emailVerified: true,
      enabled: true,
      attributes: {
        private: ['hidden'],
        tentuMarketing: ['true'],
        tentuPreferences: [JSON.stringify({ theme: 'dark' })],
      },
    } as never);
    expect(await (await request('/preferences')).json()).toEqual({ theme: 'dark' });
  });
  it('changes appearance without rewriting concurrent account state or consent', async () => {
    const { client, request } = await setup();
    client.getUser.mockResolvedValue({
      id: actor,
      attributes: {
        private: ['protected'],
        tentuMarketing: ['false'],
        tentuPreferences: [JSON.stringify({ theme: 'dark' })],
      },
    } as never);
    expect((await request('/preferences', 'PUT', { theme: 'light' })).status).toBe(204);
    expect(client.updateUser).toHaveBeenCalledWith(actor, {
      attributes: { tentuPreferences: [JSON.stringify({ theme: 'light' })] },
    });
  });
});

describe('connected identities', () => {
  it('does not replace a missing user bearer with service credentials', async () => {
    const { request } = await setup();
    const response = await request('/identities');
    expect(response.status).toBe(401);
  });
  it('forwards only the user bearer and strips unrecognized provider fields', async () => {
    const { request } = await setup();
    const nativeFetch = globalThis.fetch;
    const upstream = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      if (String(url).endsWith('/score-identities')) {
        expect(init?.headers).toEqual({ Authorization: 'Bearer own-user' });
        expect(init?.redirect).toBe('error');
        return new Response(
          JSON.stringify({
            providers: [
              {
                alias: 'google',
                displayName: 'Google',
                enabled: true,
                linked: true,
                canDisconnect: true,
                externalUsername: 'me@example.test',
                token: 'never-return',
              },
            ],
          }),
        );
      }
      return nativeFetch(url, init);
    });
    const response = await request('/identities', 'GET', undefined, {
      Authorization: 'Bearer own-user',
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(JSON.stringify(await response.json())).not.toContain('never-return');
    expect(upstream).toHaveBeenCalled();
  });
});

describe('shared personal profile', () => {
  it('stores and projects only the authenticated profile and social links', async () => {
    const { request, client } = await setup();
    const profile = {
      displayName: 'Researcher',
      bio: 'SCORE researcher',
      city: 'Sevilla',
      country: 'Spain',
      dateOfBirth: '1990-01-01',
    };
    const socialLinks = {
      linkedin: 'https://linkedin.com/in/researcher',
      instagram: '',
      facebook: '',
      x: 'https://x.com/researcher',
    };
    expect((await request('/profile', 'PATCH', { profile, socialLinks })).status).toBe(204);
    expect(client.updateUser).toHaveBeenCalledWith(actor, {
      attributes: {
        scoreProfile: [JSON.stringify(profile)],
        scoreSocialLinks: [JSON.stringify(socialLinks)],
      },
    });
    client.getUser.mockResolvedValue({
      id: actor,
      email: 'me@example.test',
      attributes: {
        private: ['secret'],
        scoreProfile: [JSON.stringify(profile)],
        scoreSocialLinks: [JSON.stringify(socialLinks)],
      },
    } as never);
    const value = await (await request('/me')).json();
    expect(value).toMatchObject({ profile, socialLinks, capabilities: { accountDeletion: true } });
    expect(value).not.toHaveProperty('attributes');
    expect(JSON.stringify(value)).not.toContain('secret');
  });
  it('validates dates, sizes, known social providers and prevents attribute injection', async () => {
    const { request, client } = await setup();
    for (const payload of [
      {},
      { userId: target, profile: {} },
      { roles: ['administrador'] },
      { profile: { dateOfBirth: '2020-02-31' } },
      { profile: { dateOfBirth: '2999-01-01' } },
      { profile: { bio: 'x'.repeat(201) } },
      { socialLinks: { website: 'https://example.test' } },
      { socialLinks: { x: 'javascript:alert(1)' } },
      { socialLinks: { linkedin: 'https://linkedin.com.evil.test/in/me' } },
      { socialLinks: { x: 'https://x.com@evil.test/me' } },
    ])
      expect((await request('/profile', 'PATCH', payload)).status).toBe(400);
    expect(client.updateUser).not.toHaveBeenCalled();
  });
  it('supports clearing optional groups and preserves all omitted fields', async () => {
    const { request, client } = await setup();
    expect((await request('/profile', 'PATCH', { socialLinks: {} })).status).toBe(204);
    expect(client.updateUser).toHaveBeenCalledWith(actor, {
      attributes: {
        scoreSocialLinks: [JSON.stringify({ linkedin: '', instagram: '', facebook: '', x: '' })],
      },
    });
    expect(
      (await request('/profile', 'PATCH', { profile: { dateOfBirth: '2000-02-29' } })).status,
    ).toBe(204);
    expect(client.updateUser.mock.calls[1]![1].attributes).not.toHaveProperty('scoreSocialLinks');
  });
  it('accepts SPHERE avatar artwork and hex colors without changing personal details', async () => {
    const { request, client } = await setup();
    const avatar = {
      kind: 'icon',
      assetId: 'avatar-9',
      backgroundColor: '#be1d37',
      foregroundColor: '#ffffff',
    };
    expect((await request('/avatar', 'PATCH', avatar)).status).toBe(204);
    expect(client.updateUser).toHaveBeenCalledWith(actor, {
      attributes: { tentuAvatar: [JSON.stringify(avatar)] },
    });
    for (const input of [
      { ...avatar, assetId: '../../evil.svg' },
      { ...avatar, foregroundColor: 'url(evil)' },
      { ...avatar, userId: target },
    ])
      expect((await request('/avatar', 'PATCH', input)).status).toBe(400);
  });
  it('disables self deletion for protected and delegated administrative accounts', async () => {
    const { request, client } = await setup();
    for (const role of ['administrador', 'admin', 'admin-web:local:access']) {
      client.getUserRealmEffectiveRoles.mockResolvedValue([{ id: 'role', name: role }]);
      expect((await (await request('/me')).json()).capabilities.accountDeletion).toBe(false);
    }
    expect((await request('/me', 'DELETE')).status).toBe(404);
    expect(client.deleteUser).not.toHaveBeenCalled();
  });
});
