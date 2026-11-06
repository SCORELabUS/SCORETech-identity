import { PreferencesWriteSchema, readPreferences } from './preferences.js';
import { createAccountRateLimit } from './rate-limit.js';
import { describeDevice, type IdentityAccountClient } from '@scoretech/identity-internal';
import { Router } from 'express';
import { z } from 'zod';
import type { AppConfig } from '../../config/app-config.js';
import type { Principal } from '@scoretech/identity-internal';
import type { Logger } from '@scoretech/identity-internal';
import { asyncHandler } from '@scoretech/identity-internal';
import { HttpError } from '@scoretech/identity-internal';
import { AvatarStorage } from './avatar-storage.js';

const Color = z.enum([
  'graphite',
  'tentu',
  'stone',
  'lime',
  'paper',
  'charcoal',
  'cyan',
  'pink',
  'purple',
  'orange',
  'black',
  'white',
]);
const AvatarSchema = z.discriminatedUnion('kind', [
  z
    .object({ kind: z.literal('initials'), backgroundColor: Color, foregroundColor: Color })
    .strict(),
  z
    .object({
      kind: z.literal('icon'),
      assetId: z.enum(['spark', 'rocket', 'heart', 'leaf', 'star']),
      backgroundColor: Color,
      foregroundColor: Color,
    })
    .strict(),
  z
    .object({ kind: z.literal('preset'), assetId: z.enum(['owl', 'fox', 'octopus', 'robot']) })
    .strict(),
  z
    .object({
      kind: z.literal('photo'),
      imageKey: z.string().regex(/^avatars\/[A-Za-z0-9-]+\/[A-Za-z0-9-]+\.(jpg|png|webp)$/),
    })
    .strict(),
]);
type Avatar = z.infer<typeof AvatarSchema>;
interface AuthorizationCatalogue {
  permissions: string[];
  roles: string[];
}
type AuthorizationCatalogueLoader = () => Promise<AuthorizationCatalogue>;
const ProfileSchema = z
  .object({
    firstName: z.string().trim().min(1).max(100),
    lastName: z.string().trim().max(100),
    phone: z
      .string()
      .trim()
      .regex(/^\+?[1-9][0-9]{6,14}$/)
      .optional()
      .or(z.literal('')),
    avatar: AvatarSchema.optional(),
  })
  .strict();
export const createAccountRouter = (
  client: IdentityAccountClient,
  config: AppConfig,
  logger: Logger,
  authorizationCatalogue?: AuthorizationCatalogueLoader,
): Router => {
  const router = Router();
  router.post(
    '/step-up',
    createAccountRateLimit(10, 60_000),
    asyncHandler(async (request, response) => {
      const input = z
        .object({ scope: z.literal('self:security'), origin: z.string().url() })
        .strict()
        .parse(request.body);
      if (!config.APP_CORS_ORIGINS.includes(input.origin))
        throw new HttpError(403, 'origin_not_allowed', 'Origin not allowed.');
      // Only the caller's verified bearer is forwarded; service credentials cannot mint user proofs.
      const bearer = request.get('authorization');
      if (!bearer) throw new HttpError(401, 'unauthorized', 'A signed-in session is required.');
      const provider = await fetch(
        `${(config.APP_KEYCLOAK_TRANSPORT_URL ?? config.APP_KEYCLOAK_ISSUER).replace(/\/$/, '')}/tentu-step-up`,
        {
          method: 'POST',
          headers: { Authorization: bearer, 'Content-Type': 'application/json' },
          body: JSON.stringify(input),
          redirect: 'error',
          signal: AbortSignal.timeout(15_000),
        },
      );
      if (!provider.ok)
        throw new HttpError(
          provider.status === 401
            ? 401
            : provider.status === 403
              ? 403
              : provider.status === 429
                ? 429
                : 503,
          'verification_unavailable',
          'Unable to start identity verification.',
        );
      const value: unknown = await provider.json();
      response.json(
        z
          .object({
            ticket: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
            expiresAt: z.number().int().positive(),
          })
          .parse(value),
      );
    }),
  );
  const storage = config.APP_AVATAR_BUCKET
    ? new AvatarStorage(config.APP_AVATAR_BUCKET, config.APP_AVATAR_REGION, {
        endpoint: config.APP_AVATAR_ENDPOINT,
        forcePathStyle: config.APP_AVATAR_FORCE_PATH_STYLE,
      })
    : undefined;
  const legacy = {
    violet: 'graphite',
    ocean: 'tentu',
    forest: 'stone',
    sunset: 'lime',
    rose: 'paper',
    slate: 'charcoal',
  } as const;
  const fallbackAvatar: Avatar = {
    kind: 'initials',
    backgroundColor: 'graphite',
    foregroundColor: 'paper',
  };
  const readAvatar = (subject: string, value: string | undefined): Avatar => {
    if (!value) return fallbackAvatar;
    if (value in legacy)
      return {
        kind: 'initials',
        backgroundColor: legacy[value as keyof typeof legacy],
        foregroundColor: 'graphite',
      };
    try {
      const avatar = AvatarSchema.parse(JSON.parse(value));
      return avatar.kind === 'photo' && !avatar.imageKey.startsWith(`avatars/${subject}/`)
        ? fallbackAvatar
        : avatar;
    } catch {
      return fallbackAvatar;
    }
  };
  const presentAvatar = async (subject: string, avatar: Avatar) =>
    avatar.kind === 'photo' && storage && avatar.imageKey.startsWith(`avatars/${subject}/`)
      ? { ...avatar, imageUrl: await storage.signedReadUrl(avatar.imageKey) }
      : avatar;
  // Self-service always derives the target from the verified JWT, never from input.
  router.get(
    '/me',
    asyncHandler(async (_request, response) => {
      const { subject, effectiveRoleNames } = response.locals.principal as Principal;
      const [user, roles, catalogue] = await Promise.all([
        client.getUser(subject),
        effectiveRoleNames !== undefined
          ? Promise.resolve(effectiveRoleNames.map((name) => ({ name })))
          : (client.getUserRealmEffectiveRoles?.(subject) ?? client.getUserRealmRoles(subject)),
        authorizationCatalogue?.() ?? Promise.resolve({ permissions: [], roles: [] }),
      ]);
      const catalogueRoles = new Set(catalogue.roles);
      const cataloguePermissions = new Set(catalogue.permissions);
      const displayRoles = new Set<string>();
      const permissions = new Set<string>();
      for (const role of roles) {
        const displayName =
          role.name === 'admin' && catalogueRoles.has('administrador')
            ? 'administrador'
            : role.name;
        if (catalogueRoles.has(displayName)) {
          displayRoles.add(displayName);
        } else if (cataloguePermissions.has(displayName)) {
          permissions.add(displayName);
        }
      }
      const avatar = readAvatar(subject, user.attributes?.tentuAvatar?.[0]);
      response.json({
        id: user.id,
        username: user.username,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        emailVerified: user.emailVerified,
        createdTimestamp: user.createdTimestamp,
        phone: user.attributes?.tentuPhone?.[0],
        avatar: await presentAvatar(subject, avatar),
        capabilities: { avatarUpload: Boolean(storage) },
        roles: [...displayRoles].sort(),
        permissions: [...permissions].sort(),
      });
    }),
  );
  router.get(
    '/preferences',
    asyncHandler(async (_request, response) => {
      const { subject } = response.locals.principal as Principal;
      const user = await client.getUser(subject);
      response.json(readPreferences(user.attributes));
    }),
  );
  router.put(
    '/preferences',
    asyncHandler(async (request, response) => {
      const { subject } = response.locals.principal as Principal;
      const input = PreferencesWriteSchema.parse(request.body);
      const user = await client.getUser(subject);
      const current = readPreferences(user.attributes);
      const preferences = { ...current, ...input };
      await client.updateUser(subject, {
        attributes: { tentuPreferences: [JSON.stringify(preferences)] },
      });
      logger.info('identity account action', {
        audit: true,
        action: 'account.preferences_updated',
        actor_id: subject,
      });
      response.status(204).end();
    }),
  );
  router.get(
    '/security',
    asyncHandler(async (_request, response) => {
      const { subject } = response.locals.principal as Principal;
      if (!client.listCredentials)
        throw new HttpError(503, 'credentials_unavailable', 'Unable to load your sign-in methods.');
      const [credentials, roles, user] = await Promise.all([
        client.listCredentials(subject),
        client.getUserRealmEffectiveRoles?.(subject) ?? client.getUserRealmRoles(subject),
        client.getUser(subject),
      ]);
      const passkeys = credentials.filter(
        (credential) => credential.type === 'webauthn-passwordless',
      );
      const totp = credentials.filter((credential) => credential.type === 'otp');
      const administrator = roles.some(
        (role) =>
          role.name === 'administrador' ||
          /^admin-web:(?:local|staging|production):access$/.test(role.name),
      );
      response.json({
        administrator,
        passkeys: passkeys.map(({ id, userLabel, createdDate }) => ({
          id,
          label: userLabel || 'Passkey',
          createdAt: createdDate,
        })),
        totp: totp.map(({ id, userLabel }) => ({ id, label: userLabel || 'Authenticator app' })),
        suggestPasskey:
          !administrator &&
          !passkeys.length &&
          !totp.length &&
          !user.attributes?.tentuPasskeySuggestionSeen?.length,
      });
    }),
  );
  router.post(
    '/security/passkey-suggestion',
    asyncHandler(async (_request, response) => {
      const { subject } = response.locals.principal as Principal;
      // Persist the first presentation across browsers. No caller-controlled user target.
      await client.updateUser(subject, { attributes: { tentuPasskeySuggestionSeen: ['true'] } });
      response.sendStatus(204);
    }),
  );
  router.patch(
    '/me',
    asyncHandler(async (request, response) => {
      const { subject } = response.locals.principal as Principal;
      const { firstName, lastName, phone, avatar } = ProfileSchema.parse(request.body);
      if (avatar?.kind === 'photo') {
        if (!storage)
          throw new HttpError(
            503,
            'avatar_upload_unavailable',
            'Photo uploads are not configured.',
          );
        await storage.assertOwnedImage(subject, avatar.imageKey);
      }
      const previousAvatar = avatar
        ? readAvatar(subject, (await client.getUser(subject)).attributes?.tentuAvatar?.[0])
        : undefined;
      const attributes: Record<string, string[]> = {
        tentuUpdatedAt: [new Date().toISOString()],
      };
      if (avatar) attributes.tentuAvatar = [JSON.stringify(avatar)];
      if (phone !== undefined) attributes.tentuPhone = phone ? [phone] : [];
      await client.updateUser(subject, {
        firstName,
        lastName,
        attributes,
      });
      if (
        storage &&
        previousAvatar?.kind === 'photo' &&
        previousAvatar.imageKey.startsWith(`avatars/${subject}/`) &&
        previousAvatar.imageKey !== (avatar?.kind === 'photo' ? avatar.imageKey : undefined)
      )
        void storage.delete(previousAvatar.imageKey).catch(() => undefined);
      logger.info('identity account action', {
        audit: true,
        action: 'account.profile_updated',
        actor_id: subject,
      });
      response.status(204).end();
    }),
  );
  router.get(
    '/sessions',
    asyncHandler(async (request, response) => {
      const principal = response.locals.principal as Principal;
      const sessions = await client.listSessions(principal.subject);
      // Old realms may not grant event access yet. Session revocation stays available.
      const history = await client
        .listSecurityEvents?.({ user: principal.subject, max: 100 })
        .catch(() => undefined);
      response.json({
        sessions: sessions.map((session) => {
          const current = session.id === principal.sessionId;
          const event = history?.events.find(
            (item) =>
              item.userId === principal.subject && item.sessionId === session.id && item.browser,
          );
          const device = event
            ? {
                browser: event.browser,
                operatingSystem: event.operatingSystem,
                device: event.device,
              }
            : current
              ? describeDevice(request.get('User-Agent'))
              : {};
          return { ...session, ...device, current };
        }),
      });
    }),
  );
  router.get(
    '/sessions/:sessionId/activity',
    asyncHandler(async (request, response) => {
      const principal = response.locals.principal as Principal;
      const sessions = await client.listSessions(principal.subject);
      const session = sessions.find((item) => item.id === request.params.sessionId);
      if (!session) throw new HttpError(404, 'session_not_found', 'Session not found.');
      if (!client.listSecurityEvents)
        throw new HttpError(503, 'events_unavailable', 'Activity is unavailable.');
      const page = await client.listSecurityEvents({ user: principal.subject, first: 0, max: 100 });
      const events = page.events.filter(
        (event) => event.userId === principal.subject && event.sessionId === session.id,
      );
      response.json({
        ...page,
        events,
        applications: [
          ...new Set([
            ...Object.values(session.clients ?? {}),
            ...events
              .filter((event) => !event.error && event.type === 'LOGIN')
              .flatMap((event) => (event.clientId ? [event.clientId] : [])),
          ]),
        ],
      });
    }),
  );
  router.post(
    '/avatar-upload',
    createAccountRateLimit(20, 60_000),
    asyncHandler(async (request, response) => {
      if (!storage)
        throw new HttpError(503, 'avatar_upload_unavailable', 'Photo uploads are not configured.');
      const { contentType } = z.object({ contentType: z.string() }).strict().parse(request.body);
      response.json(
        await storage.createUpload((response.locals.principal as Principal).subject, contentType),
      );
    }),
  );
  router.delete(
    '/sessions/:sessionId',
    asyncHandler(async (request, response) => {
      const subject = (response.locals.principal as Principal).subject;
      await client.logoutSession(
        subject,
        z.string().min(1).max(300).parse(request.params.sessionId),
      );
      logger.info('identity account action', {
        audit: true,
        action: 'account.session_revoked',
        actor_id: subject,
      });
      response.status(204).end();
    }),
  );
  router.post(
    '/email-verification',
    createAccountRateLimit(5, 10 * 60_000),
    asyncHandler(async (_request, response) => {
      const subject = (response.locals.principal as Principal).subject;
      await client.executeActionsEmail(subject, ['VERIFY_EMAIL'], {
        lifespan: config.APP_ACTIVATION_LIFESPAN_SECONDS,
        clientId: config.APP_ACCOUNT_CLIENT_ID,
        redirectUri: config.APP_ACCOUNT_PUBLIC_URL,
      });
      logger.info('identity account action', {
        audit: true,
        action: 'account.email_verification_requested',
        actor_id: subject,
      });
      response.status(204).end();
    }),
  );
  router.post(
    '/logout',
    asyncHandler(async (_request, response) => {
      const { subject } = response.locals.principal as Principal;
      await client.logoutUser(subject);
      logger.info('identity account action', {
        audit: true,
        action: 'account.sessions_revoked',
        actor_id: subject,
      });
      response.status(204).end();
    }),
  );
  return router;
};
