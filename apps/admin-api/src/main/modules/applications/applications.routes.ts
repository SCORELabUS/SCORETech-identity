import { Router, type Response } from 'express';
import { z } from 'zod';
import type { AppConfig } from '../../config/app-config.js';
import type { Principal } from '../auth/oidc-authenticator.js';
import { AccessRuleSchema } from '../catalogue/catalogue-model.js';
import { asyncHandler } from '../../shared/http/async-handler.js';
import { HttpError } from '../../shared/http/errors.js';
import type { Logger } from '../../shared/logging/logger.js';

const ClientId = z.string().regex(/^score-app-[a-f0-9-]{36}$/);
const Version = z.string().uuid();
const Permission = z
  .string()
  .min(3)
  .max(160)
  .refine(
    (name) => !/^(identity|admin-web|account-web):/.test(name),
    'Select an application permission.',
  );
const Settings = z
  .object({
    name: z.string().trim().min(1).max(150),
    kind: z.enum(['public', 'confidential']),
    origin: AccessRuleSchema.shape.origin,
    redirectUris: z.array(z.string().url().max(2048)).min(1).max(10),
    postLogoutRedirectUris: z.array(z.string().url().max(2048)).max(10),
    requiredPermissions: z.array(Permission).min(1).max(1000),
    enabled: z.boolean(),
  })
  .strict();
const View = Settings.extend({ clientId: ClientId, version: Version }).strip();
export const ApplicationSettings = Settings.superRefine((input, context) => {
  for (const key of ['redirectUris', 'postLogoutRedirectUris'] as const) {
    if (new Set(input[key]).size !== input[key].length)
      context.addIssue({ code: z.ZodIssueCode.custom, path: [key], message: 'Use unique URLs.' });
    for (const value of input[key]) {
      let uri: URL;
      try {
        uri = new URL(value);
      } catch {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: 'Use a valid absolute URL.',
        });
        continue;
      }
      if (
        uri.origin !== input.origin ||
        uri.username ||
        uri.password ||
        uri.hash ||
        value.includes('*') ||
        value.includes('\\')
      )
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: 'Use exact URLs within the application origin.',
        });
    }
  }
  if (new Set(input.requiredPermissions).size !== input.requiredPermissions.length)
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['requiredPermissions'],
      message: 'Use unique permissions.',
    });
});

export function createApplicationsRouter(config: AppConfig, logger: Logger): Router {
  const router = Router();
  router.use((_request, response, next) => {
    const actor = response.locals.principal as Principal;
    if (
      !actor.roles.includes('identity:roles:manage') ||
      !actor.effectiveRoleNames?.includes('identity:roles:manage') ||
      !actor.effectiveRoleNames.includes('administrador')
    )
      return next(
        new HttpError(
          403,
          'protected_configuration',
          'A current identity administrator with catalogue management access is required.',
        ),
      );
    next();
  });
  async function call(
    response: Response,
    token: string,
    suffix: string,
    method: string,
    body?: unknown,
  ) {
    const complete = (response.locals.beginIdentityOperation as (() => () => void) | undefined)?.();
    try {
      const base = (config.APP_KEYCLOAK_TRANSPORT_URL ?? config.APP_KEYCLOAK_ISSUER).replace(
        /\/$/,
        '',
      );
      const result = await fetch(`${base}/score-applications${suffix}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: 'error',
        signal: AbortSignal.timeout(15000),
      });
      if (!result.ok) {
        const messages: Record<number, string> = {
          400: 'Review the application URLs, permissions and client settings.',
          403: 'A current identity administrator authenticated with a passkey is required.',
          404: 'Managed application not found.',
          409: 'The application has changed or conflicts with existing configuration. Refresh before retrying.',
        };
        throw new HttpError(
          result.status >= 500 ? 503 : result.status,
          'application_operation_failed',
          messages[result.status] ??
            'The application operation could not be completed. Refresh the application list before retrying.',
        );
      }
      try {
        return await result.json();
      } catch {
        throw new HttpError(
          502,
          'invalid_provider_response',
          'The application response could not be verified. Refresh before retrying.',
        );
      }
    } finally {
      complete?.();
    }
  }
  function parse<T>(schema: z.ZodType<T>, value: unknown): T {
    const result = schema.safeParse(value);
    if (!result.success)
      throw new HttpError(
        502,
        'invalid_provider_response',
        'The application response could not be verified. Refresh before retrying.',
      );
    return result.data;
  }
  router.get(
    '/',
    asyncHandler(async (request, response) => {
      const result = parse(
        z.object({ applications: z.array(View) }),
        await call(response, request.get('authorization')!.slice(7), '', 'GET'),
      );
      response.json({
        ...result,
        issuer: config.APP_KEYCLOAK_ISSUER,
        discoveryUrl:
          config.APP_KEYCLOAK_ISSUER.replace(/\/$/, '') + '/.well-known/openid-configuration',
        capabilities: { manageApplications: true },
      });
    }),
  );
  router.post(
    '/',
    asyncHandler(async (request, response) => {
      const input = ApplicationSettings.parse(request.body);
      if (
        config.APP_IDENTITY_ENVIRONMENT !== 'local' &&
        new URL(input.origin).protocol !== 'https:'
      )
        throw new HttpError(400, 'invalid_origin', 'Use HTTPS for deployed applications.');
      const result = parse(
        z.object({ application: View, clientSecret: z.string().min(16).optional() }),
        await call(response, request.get('authorization')!.slice(7), '', 'POST', input),
      );
      if (
        result.application.kind !== input.kind ||
        (input.kind === 'public' && result.clientSecret !== undefined) ||
        (input.kind === 'confidential' && !result.clientSecret)
      )
        throw new HttpError(
          502,
          'invalid_provider_response',
          'The application credentials could not be verified.',
        );
      logger.info('application created', {
        audit: true,
        actor_id: (response.locals.principal as Principal).subject,
        client_id: result.application.clientId,
      });
      response.status(201).json(result);
    }),
  );
  router.put(
    '/:clientId',
    asyncHandler(async (request, response) => {
      const clientId = ClientId.parse(request.params.clientId);
      const input = Settings.extend({ version: Version }).strict().parse(request.body);
      const { version: _version, ...settings } = input;
      void _version;
      ApplicationSettings.parse(settings);
      if (
        config.APP_IDENTITY_ENVIRONMENT !== 'local' &&
        new URL(input.origin).protocol !== 'https:'
      )
        throw new HttpError(400, 'invalid_origin', 'Use HTTPS for deployed applications.');
      const result = parse(
        z.object({ application: View, clientSecret: z.string().min(16).optional() }),
        await call(response, request.get('authorization')!.slice(7), '/' + clientId, 'PUT', input),
      );
      if (
        result.application.clientId !== clientId ||
        result.application.kind !== input.kind ||
        (input.kind === 'public' && result.clientSecret !== undefined)
      )
        throw new HttpError(
          502,
          'invalid_provider_response',
          'The application response could not be verified.',
        );
      logger.info('application updated', {
        audit: true,
        actor_id: (response.locals.principal as Principal).subject,
        client_id: clientId,
      });
      response.json(result);
    }),
  );
  router.delete(
    '/:clientId',
    asyncHandler(async (request, response) => {
      const clientId = ClientId.parse(request.params.clientId);
      const input = z.object({ version: Version }).strict().parse(request.body);
      const result = parse(
        z.object({ clientId: ClientId, deleted: z.literal(true) }),
        await call(
          response,
          request.get('authorization')!.slice(7),
          '/' + clientId,
          'DELETE',
          input,
        ),
      );
      if (result.clientId !== clientId)
        throw new HttpError(
          502,
          'invalid_provider_response',
          'The application deletion response could not be verified. Refresh before retrying.',
        );
      logger.info('application deleted', {
        audit: true,
        actor_id: (response.locals.principal as Principal).subject,
        client_id: clientId,
      });
      response.json(result);
    }),
  );
  router.post(
    '/:clientId/secret/reveal',
    asyncHandler(async (request, response) => {
      const clientId = ClientId.parse(request.params.clientId);
      const input = z.object({ version: Version }).strict().parse(request.body);
      const result = parse(
        z.object({ clientId: ClientId, clientSecret: z.string().min(16), version: Version }),
        await call(
          response,
          request.get('authorization')!.slice(7),
          '/' + clientId + '/secret/reveal',
          'POST',
          input,
        ),
      );
      if (result.clientId !== clientId || result.version !== input.version)
        throw new HttpError(
          502,
          'invalid_provider_response',
          'The application credential response could not be verified. Refresh before retrying.',
        );
      logger.info('application secret revealed', {
        audit: true,
        actor_id: (response.locals.principal as Principal).subject,
        client_id: clientId,
      });
      response.json(result);
    }),
  );
  router.post(
    '/:clientId/secret',
    asyncHandler(async (request, response) => {
      const clientId = ClientId.parse(request.params.clientId);
      const input = z.object({ version: Version }).strict().parse(request.body);
      const result = parse(
        z.object({ application: View, clientId: ClientId, clientSecret: z.string().min(16) }),
        await call(
          response,
          request.get('authorization')!.slice(7),
          '/' + clientId + '/secret',
          'POST',
          input,
        ),
      );
      if (
        result.application.clientId !== clientId ||
        result.clientId !== clientId ||
        result.application.kind !== 'confidential'
      )
        throw new HttpError(
          502,
          'invalid_provider_response',
          'The application response could not be verified.',
        );
      logger.info('application secret rotated', {
        audit: true,
        actor_id: (response.locals.principal as Principal).subject,
        client_id: clientId,
      });
      response.json(result);
    }),
  );
  return router;
}
