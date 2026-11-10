import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import type { Server } from 'node:http';
import express from 'express';
import sharp from 'sharp';
import { errorHandler } from '@scoretech/identity-internal';
import { createAccountRouter } from '../src/main/modules/account/account.routes.js';
import { LocalAvatarStorage } from '../src/main/modules/account/local-avatar-storage.js';
import { loadConfig } from '../src/main/config/app-config.js';
const config = loadConfig({
  APP_CORS_ORIGINS: 'http://localhost:5173',
  APP_KEYCLOAK_ISSUER: 'https://id.example.test/identity/auth/realms/score',
  APP_KEYCLOAK_ADMIN_URL: 'http://identity:8080',
  APP_KEYCLOAK_REALM: 'score',
  APP_KEYCLOAK_ADMIN_CLIENT_SECRET: 'test-secret',
  APP_ACCOUNT_PUBLIC_URL: 'https://id.example.test/identity/account/',
});

const actor = '11111111-1111-4111-8111-111111111111';
const servers: Server[] = [];
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'score-avatar-'));
  directories.push(directory);
  const user = {
    id: actor,
    email: 'own@example.invalid',
    attributes: {} as Record<string, string[]>,
  };
  const client = {
    getUser: vi.fn().mockImplementation(async () => user),
    updateUser: vi.fn().mockImplementation(async (_subject, update) => {
      Object.assign(user.attributes, update.attributes);
    }),
    getUserRealmRoles: vi.fn().mockResolvedValue([]),
  };
  const app = express();
  app.use(express.json());
  app.use((_req, res, next) => {
    res.locals.principal = { subject: actor };
    next();
  });
  app.use(
    createAccountRouter(client as never, { ...config, APP_AVATAR_DIRECTORY: directory }, {
      info: vi.fn(),
    } as never),
  );
  app.use(errorHandler);
  const server = app.listen(0, '127.0.0.1');
  servers.push(server);
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw Error('No address');
  return { client, user, directory, url: `http://127.0.0.1:${address.port}` };
}
describe('private avatar photos', () => {
  it('normalizes real images, persists across storage instances and replaces the old owned file', async () => {
    const { url, client, user, directory } = await setup();
    const bytes = await sharp({
      create: { width: 600, height: 400, channels: 3, background: '#be1d37' },
    })
      .png()
      .toBuffer();
    const upload = await fetch(url + '/avatar-image', {
      method: 'POST',
      headers: { 'Content-Type': 'image/png' },
      body: bytes,
    });
    expect(upload.status).toBe(201);
    const { avatar } = await upload.json();
    expect(avatar.kind).toBe('photo');
    expect(avatar.imageKey).toMatch(new RegExp(`^avatars/${actor}/.+\\.webp$`));
    const saved = Buffer.from(avatar.imageUrl.split(',')[1], 'base64');
    expect(await sharp(saved).metadata()).toMatchObject({
      width: 256,
      height: 256,
      format: 'webp',
    });
    expect(client.updateUser).toHaveBeenCalledWith(actor, {
      attributes: { tentuAvatar: [JSON.stringify({ kind: 'photo', imageKey: avatar.imageKey })] },
    });
    const reopened = new LocalAvatarStorage(directory);
    expect(await reopened.signedReadUrl(avatar.imageKey)).toBe(avatar.imageUrl);
    await expect(reopened.assertOwnedImage('another-user', avatar.imageKey)).rejects.toThrow(
      'does not belong',
    );
    await expect(reopened.signedReadUrl('../../secret.webp')).rejects.toThrow('Invalid avatar');
    const replace = await fetch(url + '/avatar', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        kind: 'initials',
        backgroundColor: '#ffffff',
        foregroundColor: '#be1d37',
      }),
    });
    expect(replace.status).toBe(204);
    expect(await readdir(join(directory, 'avatars', actor))).toEqual([]);
    expect(user.attributes.tentuAvatar?.[0]).not.toContain('photo');
  });
  it('rejects invalid, oversized and active content before storing anything', async () => {
    const { url, client, directory } = await setup();
    for (const [type, body] of [
      ['image/webp', Buffer.from('not an image')],
      ['image/svg+xml', Buffer.from('<svg/>')],
    ] as const) {
      expect(
        (
          await fetch(url + '/avatar-image', {
            method: 'POST',
            headers: { 'Content-Type': type },
            body,
          })
        ).status,
      ).toBe(400);
    }
    expect(
      (
        await fetch(url + '/avatar-image', {
          method: 'POST',
          headers: { 'Content-Type': 'image/png' },
          body: Buffer.alloc(2 * 1024 * 1024 + 1),
        })
      ).status,
    ).toBe(413);
    expect(client.updateUser).not.toHaveBeenCalled();
    expect(await readdir(directory)).toEqual([]);
  });
});
