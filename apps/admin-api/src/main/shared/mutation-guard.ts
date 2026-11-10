import type { RequestHandler } from 'express';
import {
  acquireAuthorizationLock,
  HttpError,
  type IdentityAdminClient,
  type Principal,
} from '@scoretech/identity-internal';
import type { AppConfig } from '../config/app-config.js';
import { identityServiceAccess } from './identity-policies.js';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export function assertAppliedAuthorization(config: AppConfig): void {
  try {
    const state = JSON.parse(readFileSync(config.APP_CATALOGUE_STATE_PATH, 'utf8')) as {
      state?: string;
      observedRevision?: string;
    };
    const active = JSON.parse(
      readFileSync(
        join(dirname(config.APP_AUTHORIZATION_CATALOGUE_PATH), 'active-registry.json'),
        'utf8',
      ),
    ) as { revision?: string };
    if (
      state.state === 'applied' &&
      typeof active.revision === 'string' &&
      /^[a-f0-9]{64}$/.test(active.revision) &&
      state.observedRevision === active.revision
    )
      return;
  } catch {
    /* A missing or partial projection is never authority. */
  }
  throw new HttpError(
    503,
    'catalogue_not_applied',
    'Wait until the authorization catalogue is applied and verified.',
  );
}

// Shared by every Admin API app in this process. Multiple API processes require
// cross-process coordination before deployment; an instance-local queue is unsafe.
const mutationQueues = new Map<string, Promise<void>>();
const readMethods = new Set(['GET', 'HEAD', 'OPTIONS']);

const acquireMutation = async (key: string): Promise<() => void> => {
  const previous = mutationQueues.get(key) ?? Promise.resolve();
  let unlock!: () => void;
  const current = new Promise<void>((resolve) => {
    unlock = resolve;
  });
  const tail = previous.then(() => current);
  mutationQueues.set(key, tail);
  await previous;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    unlock();
    if (mutationQueues.get(key) === tail) mutationQueues.delete(key);
  };
};

const revalidatePrincipal = async (
  principal: Principal,
  client: IdentityAdminClient,
  config: AppConfig,
): Promise<void> => {
  if (!principal.sessionId)
    throw new HttpError(401, 'invalid_session', 'A current signed-in session is required.');

  const [actor, roles, sessions] = await Promise.all([
    client.getUser(principal.subject),
    client.getUserRealmEffectiveRoles?.(principal.subject) ??
      client.getUserRealmRoles(principal.subject),
    client.listSessions(principal.subject),
  ]);
  if (!actor.enabled) throw new HttpError(403, 'account_disabled', 'Your account is disabled.');
  if (
    actor.id !== principal.subject ||
    !sessions.some((session) => session.id === principal.sessionId)
  )
    throw new HttpError(401, 'invalid_session', 'Your session has ended. Sign in again.');

  const liveRoles = new Set(roles.map((role) => role.name));
  const access = identityServiceAccess(config.APP_IDENTITY_ENVIRONMENT);
  if (!liveRoles.has(access))
    throw new HttpError(
      403,
      'insufficient_permission',
      'Current administrative access is required.',
    );

  // A fresh lookup must happen inside the mutation queue. The authenticator may
  // have checked roles before another administrator changed this actor's access.
  principal.roles = principal.roles.filter((role) => liveRoles.has(role));
  principal.effectiveRoleNames = [...liveRoles];
};

export const createAdministrativeMutationGuard = (
  client: IdentityAdminClient,
  config: AppConfig,
): RequestHandler => {
  const key = config.APP_KEYCLOAK_ISSUER.replace(/\/$/, '');
  return (request, response, next) => {
    // Explicit fixture mode isolates route tests; production configuration must
    // keep the policy enabled.
    if (!config.APP_REQUIRE_ADMIN_PASSKEY) {
      next();
      return;
    }
    void (async () => {
      let release: (() => void) | undefined;
      let pending = 1; // Includes the guard's own asynchronous revalidation.
      let responseEnded = false;
      const finish = () => {
        responseEnded = true;
        if (pending === 0) {
          response.off('finish', finish);
          response.off('close', finish);
          delete response.locals.beginIdentityOperation;
          release?.();
        }
      };
      const complete = () => {
        pending = Math.max(0, pending - 1);
        if (responseEnded) finish();
      };
      try {
        if (!readMethods.has(request.method)) {
          release = await acquireMutation(key);
          const releaseLocal = release;
          const releaseExternal = await acquireAuthorizationLock(
            config.APP_AUTHORIZATION_LOCK_FILE,
          );
          release = () => {
            releaseExternal();
            releaseLocal();
          };
          // Reconciliation marks applying BEFORE native changes. If it dies or
          // verification fails, grants stay blocked. Catalogue repair remains
          // available, using its own non-escalation checks and the same lock.
          if (config.APP_AUTHORIZATION_LOCK_FILE && !request.path.startsWith('/catalogue/'))
            assertAppliedAuthorization(config);
          if (response.destroyed || response.writableEnded) {
            responseEnded = true;
            complete();
            return;
          }
          response.once('finish', finish);
          response.once('close', finish);
          response.locals.beginIdentityOperation = () => {
            pending += 1;
            let ended = false;
            return () => {
              if (!ended) {
                ended = true;
                complete();
              }
            };
          };
        }
        await revalidatePrincipal(response.locals.principal as Principal, client, config);
        if (response.destroyed || response.writableEnded) {
          responseEnded = true;
          complete();
          return;
        }
        next();
        complete();
      } catch (error) {
        responseEnded = true;
        complete();
        next(error);
      }
    })();
  };
};
