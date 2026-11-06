import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { once } from 'node:events';
import { request as httpRequest, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { IdentityAdminClient, Principal } from '@scoretech/identity-internal';
import { createAdministrativeMutationGuard } from '../src/main/shared/mutation-guard.js';
import { authorizeIdentityOperation } from '../src/main/modules/identity/identity-authorization.js';
import { asyncHandler } from '../src/main/shared/http/async-handler.js';
import { errorHandler, HttpError } from '../src/main/shared/http/errors.js';
import { loadConfig, type AppConfig } from '../src/main/config/app-config.js';

const firstActor = '11111111-1111-4111-8111-111111111111';
const secondActor = '22222222-2222-4222-8222-222222222222';
const target = '33333333-3333-4333-8333-333333333333';
const entry = 'admin-web:local:access';
const remove = 'identity:users:delete';
const initialRoles = [entry, remove];
const servers: Server[] = [];
const releases: Array<() => void> = [];
const pendingRequests: Promise<unknown>[] = [];

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const barrier = () => {
  const result = deferred();
  releases.push(result.resolve);
  return result;
};
const track = <T>(promise: Promise<T>): Promise<T> => {
  pendingRequests.push(promise.catch(() => undefined));
  return promise;
};

afterEach(async () => {
  releases.splice(0).forEach((release) => release());
  for (const server of servers) server.closeAllConnections();
  await Promise.all(pendingRequests.splice(0));
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

const config = (): AppConfig =>
  loadConfig({
    APP_CORS_ORIGINS: 'http://localhost:18000',
    APP_KEYCLOAK_ISSUER: `https://identity.example.test/identity/auth/realms/${randomUUID()}`,
    APP_KEYCLOAK_ADMIN_URL: 'http://identity:8080/identity/auth',
    APP_KEYCLOAK_REALM: 'score',
    APP_KEYCLOAK_ADMIN_CLIENT_SECRET: 'fixture-only',
    APP_IDENTITY_ENVIRONMENT: 'local',
    APP_REQUIRE_ADMIN_PASSKEY: 'true',
  });
const client = (liveRoles: Map<string, string[]>) => ({
  getUser: vi.fn(async (id: string) => ({ id, enabled: true, emailVerified: true })),
  getUserRealmEffectiveRoles: vi.fn(async (id: string) =>
    (liveRoles.get(id) ?? []).map((name) => ({ id: name, name })),
  ),
  listSessions: vi.fn(async (id: string) => [{ id: `session-${id}` }]),
});
type MockClient = ReturnType<typeof client>;

async function application(
  settings: AppConfig,
  identityClient: MockClient,
  actor: string,
  handler: express.RequestHandler,
  events: { arrived?: () => void; closed?: () => void } = {},
): Promise<string> {
  const app = express();
  // A completed request proves pending microtasks from an already-arrived
  // mutation had a chance to run; queued assertions must not race next().
  app.get('/queue-checkpoint', (_request, response) => response.status(204).end());
  app.use((_request, response, next) => {
    // Authenticator output deliberately reflects the old signed/live snapshot;
    // the mutation guard must revalidate it after acquiring the shared queue.
    response.locals.principal = {
      subject: actor,
      sessionId: `session-${actor}`,
      roles: [...initialRoles],
      effectiveRoleNames: [...initialRoles],
    } satisfies Principal;
    response.locals.identityEnvironment = 'local';
    if (events.closed) response.once('close', events.closed);
    events.arrived?.();
    next();
  });
  app.use(
    createAdministrativeMutationGuard(identityClient as unknown as IdentityAdminClient, settings),
  );
  app.use(authorizeIdentityOperation);
  app.delete('/users/:userId', asyncHandler(handler));
  app.use(errorHandler);
  const server = app.listen(0, '127.0.0.1');
  servers.push(server);
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing test server port.');
  return `http://127.0.0.1:${address.port}/users/${target}`;
}

describe('administrative mutation queue lifetime', () => {
  it('serializes different app instances and rechecks actor rights after the preceding mutation', async () => {
    const settings = config();
    const liveRoles = new Map([
      [firstActor, [...initialRoles]],
      [secondActor, [...initialRoles]],
    ]);
    const firstClient = client(liveRoles);
    const secondClient = client(liveRoles);
    const firstStarted = deferred();
    const secondArrived = deferred();
    const finishFirstWrite = barrier();
    const firstWrite = vi.fn(async (_request, response) => {
      firstStarted.resolve();
      await finishFirstWrite.promise;
      liveRoles.set(secondActor, [entry]);
      response.status(204).end();
    });
    const secondWrite = vi.fn(async (_request, response) => {
      response.status(204).end();
    });
    const firstUrl = await application(settings, firstClient, firstActor, firstWrite);
    const secondUrl = await application(settings, secondClient, secondActor, secondWrite, {
      arrived: secondArrived.resolve,
    });
    const firstResponse = track(fetch(firstUrl, { method: 'DELETE' }));
    await firstStarted.promise;
    const secondResponse = track(fetch(secondUrl, { method: 'DELETE' }));
    await secondArrived.promise;
    expect((await fetch(new URL('/queue-checkpoint', secondUrl))).status).toBe(204);
    expect(secondClient.getUserRealmEffectiveRoles).not.toHaveBeenCalled();
    expect(secondWrite).not.toHaveBeenCalled();
    finishFirstWrite.resolve();
    expect((await firstResponse).status).toBe(204);
    const denied = await secondResponse;
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({ error: { code: 'insufficient_permission' } });
    expect(secondClient.getUserRealmEffectiveRoles).toHaveBeenCalledWith(secondActor);
    expect(secondWrite).not.toHaveBeenCalled();
  });

  it('keeps the queue locked after client disconnect until the pending provider write actually settles', async () => {
    const settings = config();
    const liveRoles = new Map([
      [firstActor, [...initialRoles]],
      [secondActor, [...initialRoles]],
    ]);
    const firstClient = client(liveRoles);
    const secondClient = client(liveRoles);
    const firstStarted = deferred();
    const firstClosed = deferred();
    const clientClosed = deferred();
    const firstSettled = deferred();
    const secondArrived = deferred();
    const finishProviderWrite = barrier();
    const committed: string[] = [];
    const firstWrite = vi.fn(async (_request, response) => {
      firstStarted.resolve();
      await finishProviderWrite.promise;
      committed.push('first');
      response.status(204).end();
      firstSettled.resolve();
    });
    const secondWrite = vi.fn(async (_request, response) => {
      committed.push('second');
      response.status(204).end();
    });
    const firstUrl = await application(settings, firstClient, firstActor, firstWrite, {
      closed: firstClosed.resolve,
    });
    const secondUrl = await application(settings, secondClient, secondActor, secondWrite, {
      arrived: secondArrived.resolve,
    });
    const disconnected = httpRequest(firstUrl, { method: 'DELETE' });
    disconnected.on('error', clientClosed.resolve);
    disconnected.on('response', (response) => response.resume());
    disconnected.end();
    await firstStarted.promise;
    disconnected.destroy(new Error('Intentional fixture disconnect.'));
    await Promise.all([clientClosed.promise, firstClosed.promise]);
    const secondResponse = track(fetch(secondUrl, { method: 'DELETE' }));
    await secondArrived.promise;
    expect((await fetch(new URL('/queue-checkpoint', secondUrl))).status).toBe(204);
    expect(committed).toEqual([]);
    expect(secondClient.getUserRealmEffectiveRoles).not.toHaveBeenCalled();
    expect(secondWrite).not.toHaveBeenCalled();
    finishProviderWrite.resolve();
    await firstSettled.promise;
    expect((await secondResponse).status).toBe(204);
    expect(committed).toEqual(['first', 'second']);
  });

  it('releases a failed mutation so another app can proceed', async () => {
    const settings = config();
    const liveRoles = new Map([
      [firstActor, [...initialRoles]],
      [secondActor, [...initialRoles]],
    ]);
    const firstStarted = deferred();
    const secondArrived = deferred();
    const rejectProviderWrite = barrier();
    const firstUrl = await application(settings, client(liveRoles), firstActor, async () => {
      firstStarted.resolve();
      await rejectProviderWrite.promise;
      throw new HttpError(503, 'provider_unavailable', 'The fixture provider is unavailable.');
    });
    const secondWrite = vi.fn(async (_request, response) => {
      response.status(204).end();
    });
    const secondUrl = await application(settings, client(liveRoles), secondActor, secondWrite, {
      arrived: secondArrived.resolve,
    });
    const firstResponse = track(fetch(firstUrl, { method: 'DELETE' }));
    await firstStarted.promise;
    const secondResponse = track(fetch(secondUrl, { method: 'DELETE' }));
    await secondArrived.promise;
    expect((await fetch(new URL('/queue-checkpoint', secondUrl))).status).toBe(204);
    expect(secondWrite).not.toHaveBeenCalled();
    rejectProviderWrite.resolve();
    expect((await firstResponse).status).toBe(503);
    expect((await secondResponse).status).toBe(204);
    expect(secondWrite).toHaveBeenCalledOnce();
  });
});
