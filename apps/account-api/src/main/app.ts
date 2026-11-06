import cors from 'cors';
import { createAccountRouter } from './modules/account/account.routes.js';
import express from 'express';
import { randomUUID } from 'node:crypto';
import type { AppConfig } from './config/app-config.js';
import { createAdminAuthenticator } from '@scoretech/identity-internal';
import { createAccountClient } from '@scoretech/identity-internal';
import type { IdentityAccountClient } from '@scoretech/identity-internal';
import { loadAuthorizationCatalogue } from './authorization-catalogue.js';
import { errorHandler } from '@scoretech/identity-internal';
import { createLogger, type Logger } from '@scoretech/identity-internal';
import { createMetrics } from '@scoretech/identity-internal';

export interface AppDependencies {
  identityClient?: IdentityAccountClient;
  logger?: Logger;
  authorizationCatalogue?: { permissions: string[]; roles: string[] };
}

export const createApp = (config: AppConfig, dependencies: AppDependencies = {}) => {
  const app = express();
  const logger = dependencies.logger ?? createLogger(config.APP_LOG_LEVEL);
  const catalogue = () => Promise.resolve(
    dependencies.authorizationCatalogue ??
    loadAuthorizationCatalogue(config.APP_AUTHORIZATION_CATALOGUE_PATH));
  const identityClient =
    dependencies.identityClient ??
    createAccountClient({
      issuer: config.APP_KEYCLOAK_ISSUER,
      transportUrl: config.APP_KEYCLOAK_TRANSPORT_URL,
      adminUrl: config.APP_KEYCLOAK_ADMIN_URL,
      realm: config.APP_KEYCLOAK_REALM,
      clientId: config.APP_KEYCLOAK_ADMIN_CLIENT_ID,
      clientSecret: config.APP_KEYCLOAK_ADMIN_CLIENT_SECRET,
    });
  const metrics = createMetrics('identity-account-api');

  app.disable('x-powered-by');
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
      service: 'identity-account-api',
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
    '/v1/account',
    createAdminAuthenticator({
      issuer: config.APP_KEYCLOAK_ISSUER,
      transportUrl: config.APP_KEYCLOAK_TRANSPORT_URL,
      audience: config.APP_ACCOUNT_AUDIENCE,
      requireAdministrativePasskey: config.APP_REQUIRE_ADMIN_PASSKEY,
      effectiveRoles: async (subject) =>
        (
          await (identityClient.getUserRealmEffectiveRoles?.(subject) ??
            identityClient.getUserRealmRoles(subject))
        ).map((role) => role.name),
      requireAdmin: false,
      requireSession: true,
    }),
    createAccountRouter(identityClient, config, logger, catalogue),
  );
  app.use((_request, response) =>
    response.status(404).json({ error: { code: 'not_found', message: 'Resource not found.' } }),
  );
  app.use(errorHandler);
  return app;
};
