import { z } from 'zod';
import { createApplicationsRouter } from './modules/applications/applications.routes.js';
import {
  providerRequest,
  createInvitationsRouter,
} from './modules/invitations/invitations.routes.js';
import { identityServiceAccess, hasIdentityOperationPolicy } from './shared/identity-policies.js';
import { asyncHandler } from './shared/http/async-handler.js';
import type { Principal } from './modules/auth/oidc-authenticator.js';
import cors from 'cors';
import { CatalogueService } from './modules/catalogue/catalogue-service.js';
import { createCatalogueRouter } from './modules/catalogue/catalogue.routes.js';
import express from 'express';
import { randomUUID } from 'node:crypto';
import type { AppConfig } from './config/app-config.js';
import { createAdminAuthenticator } from './modules/auth/oidc-authenticator.js';
import { KeycloakAdminClient } from './modules/identity/keycloak-admin-client.js';
import { createIdentityRouter } from './modules/identity/identity.routes.js';
import type { IdentityAdminClient } from './modules/identity/types.js';
import { errorHandler, HttpError } from './shared/http/errors.js';
import { createLogger, type Logger } from './shared/logging/logger.js';
import { createMetrics } from './shared/metrics/prometheus.js';
import { createAdministrativeMutationGuard } from './shared/mutation-guard.js';

export interface AppDependencies {
  identityClient?: IdentityAdminClient;
  logger?: Logger;
  catalogue?: CatalogueService;
}

export const createApp = (config: AppConfig, dependencies: AppDependencies = {}) => {
  const app = express();
  const logger = dependencies.logger ?? createLogger(config.APP_LOG_LEVEL);
  const catalogue = dependencies.catalogue ?? new CatalogueService(config);
  const identityClient =
    dependencies.identityClient ??
    new KeycloakAdminClient({
      issuer: config.APP_KEYCLOAK_ISSUER,
      transportUrl: config.APP_KEYCLOAK_TRANSPORT_URL,
      adminUrl: config.APP_KEYCLOAK_ADMIN_URL,
      realm: config.APP_KEYCLOAK_REALM,
      clientId: config.APP_KEYCLOAK_ADMIN_CLIENT_ID,
      clientSecret: config.APP_KEYCLOAK_ADMIN_CLIENT_SECRET,
      managedRoles: config.APP_IDENTITY_MANAGED_ROLES,
      roleCatalogue: () => catalogue.assignmentRoles(config.APP_IDENTITY_ENVIRONMENT),
    });
  const metrics = createMetrics();

  app.disable('x-powered-by');
  app.use('/v1/applications', express.json({ limit: '512kb' }));
  app.use('/api/v1/applications', express.json({ limit: '512kb' }));
  app.use('/v1/catalogue', express.json({ limit: '512kb' }));
  app.use('/api/v1/catalogue', express.json({ limit: '512kb' }));
  app.use(express.json({ limit: '64kb' }));
  app.use(
    cors({
      origin: config.APP_CORS_ORIGINS,
      credentials: false,
      methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'],
      allowedHeaders: ['Content-Type', 'Authorization'],
    }),
  );
  app.use((request, response, next) => {
    const requestId = request.header('x-request-id') ?? randomUUID();
    const startedAt = performance.now();
    response.setHeader('x-request-id', requestId);
    response.on('finish', () =>
      logger.info('http request completed', {
        request_id: requestId,
        method: request.method,
        path: request.path,
        status_code: response.statusCode,
        duration_ms: Math.round((performance.now() - startedAt) * 100) / 100,
      }),
    );
    next();
  });
  app.use(metrics.middleware);
  const health = (_request: express.Request, response: express.Response): void => {
    response.json({
      status: 'UP',
      service: 'identity-admin-api',
      version: config.APP_SERVICE_VERSION,
    });
  };
  app.get('/health', health);
  app.get('/healthcheck', health);
  app.get('/ready', health);
  app.get('/metrics', metrics.handler);
  app.use((request, _response, next) => {
    if (request.url === '/api/v1' || request.url.startsWith('/api/v1/'))
      request.url = request.url.slice(4);
    next();
  });
  app.use('/v1', (_request, response, next) => {
    response.setHeader('Cache-Control', 'no-store');
    next();
  });
  app.use(
    '/v1',
    createAdminAuthenticator({
      issuer: config.APP_KEYCLOAK_ISSUER,
      transportUrl: config.APP_KEYCLOAK_TRANSPORT_URL,
      audience: config.APP_KEYCLOAK_AUDIENCE,
      requireAdministrativePasskey: config.APP_REQUIRE_ADMIN_PASSKEY,
      effectiveRoles: async (subject) =>
        (
          await (identityClient.getUserRealmEffectiveRoles?.(subject) ??
            identityClient.getUserRealmRoles(subject))
        ).map((role) => role.name),
      requireAdmin: false,
      requiredRoles: [identityServiceAccess(config.APP_IDENTITY_ENVIRONMENT)],
      allowedClients: config.APP_ADMIN_ALLOWED_CLIENTS,
    }),
  );
  app.use('/v1', (_request, response, next) => {
    response.locals.identityEnvironment = config.APP_IDENTITY_ENVIRONMENT;
    next();
  });
  app.use('/v1', createAdministrativeMutationGuard(identityClient, config));
  app.use(
    '/v1/catalogue',
    asyncHandler(async (request, response, next) => {
      const principal = response.locals.principal as Principal;
      const roles = (
        await (identityClient.getUserRealmEffectiveRoles?.(principal.subject) ??
          identityClient.getUserRealmRoles(principal.subject))
      ).map((role) => role.name);
      const operation = request.method === 'GET' ? 'identity:roles:view' : 'identity:roles:manage';
      if (
        !roles.includes(identityServiceAccess(config.APP_IDENTITY_ENVIRONMENT)) ||
        !hasIdentityOperationPolicy(roles, operation, config.APP_IDENTITY_ENVIRONMENT)
      )
        throw new HttpError(
          403,
          'insufficient_permission',
          'Current catalogue permission required.',
        );
      next();
    }),
  );
  app.use('/v1/catalogue', createCatalogueRouter(catalogue, logger));
  app.use('/v1/applications', createApplicationsRouter(config, logger));
  app.post(
    '/v1/step-up',
    asyncHandler(async (request, response) => {
      const input = z
        .object({
          scope: z.string().regex(/^user:[a-f0-9-]{36}:(credentials|deactivate)$/),
          origin: z.string().url(),
        })
        .strict()
        .parse(request.body);
      if (!config.APP_CORS_ORIGINS.includes(input.origin))
        throw new HttpError(403, 'origin_not_allowed', 'Origin not allowed.');
      response.json(
        z
          .object({ ticket: z.string().regex(/^[A-Za-z0-9_-]{43}$/), expiresAt: z.number() })
          .parse(
            await providerRequest(
              config,
              request.get('authorization')!.slice(7),
              'tentu-step-up',
              'POST',
              input,
            ),
          ),
      );
    }),
  );
  app.use('/v1/invitations', createInvitationsRouter(config, logger));
  app.use('/v1', createIdentityRouter(identityClient, logger, config));
  app.use((_request, response) =>
    response.status(404).json({ error: { code: 'not_found', message: 'Resource not found.' } }),
  );
  app.use(errorHandler);
  return app;
};
