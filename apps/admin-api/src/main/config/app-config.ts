import { secretEnvironment } from '@scoretech/identity-internal';
import { z } from 'zod';

const parseOrigins = (value: unknown): unknown => {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean);
  }
};

const EnvSchema = z.object({
  APP_AUTHORIZATION_CATALOGUE_PATH: z.string().default('/etc/identity/catalogue.json'),
  APP_CATALOGUE_STATE_PATH: z.string().default('/etc/identity/apply-status.json'),
  APP_AUTHORIZATION_LOCK_FILE: z.string().startsWith('/').optional(),
  APP_GITHUB_API_URL: z.string().url().default('https://api.github.com'),
  APP_REQUIRE_ADMIN_PASSKEY: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),
  APP_GITHUB_APP_ID: z.string().regex(/^\d+$/).optional(),
  APP_GITHUB_INSTALLATION_ID: z.string().regex(/^\d+$/).optional(),
  APP_GITHUB_PRIVATE_KEY: z.string().min(1).optional(),
  APP_CATALOGUE_REPO: z
    .string()
    .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/)
    .default('SCORELabUS/SCORETech-identity'),
  APP_CATALOGUE_BRANCH: z
    .string()
    .regex(/^[A-Za-z0-9_/-]+$/)
    .default('identity-catalogue'),

  APP_IDENTITY_MANAGED_ROLES: z
    .preprocess(parseOrigins, z.array(z.string().regex(/^[a-z][a-z0-9:-]*$/)).min(1))
    .default(['administrador', 'member', 'support']),
  APP_IDENTITY_ENVIRONMENT: z.enum(['local', 'staging', 'production']).default('local'),



  APP_ACTIVATION_LIFESPAN_SECONDS: z.coerce.number().int().min(300).max(86400).default(3600),
  APP_ACCOUNT_PUBLIC_URL: z.string().url().optional(),
  APP_ACCOUNT_CLIENT_ID: z.string().default('identity-account-web'),

  APP_PORT: z.coerce.number().int().positive().default(8080),
  APP_LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  APP_CORS_ORIGINS: z.preprocess(parseOrigins, z.array(z.string().url()).min(1)),
  APP_SERVICE_VERSION: z.string().default('0.1.0'),
  APP_ADMIN_ALLOWED_CLIENTS: z
    .preprocess(parseOrigins, z.array(z.string().min(1)).min(1))
    .default(['identity-admin-web']),
  APP_KEYCLOAK_ISSUER: z.string().url(),
  APP_KEYCLOAK_TRANSPORT_URL: z.string().url().optional(),
  APP_KEYCLOAK_ADMIN_URL: z.string().url(),
  APP_KEYCLOAK_REALM: z.string().min(1),
  APP_KEYCLOAK_AUDIENCE: z.string().min(1).default('identity-admin-api'),
  APP_KEYCLOAK_ADMIN_CLIENT_ID: z.string().min(1).default('identity-admin-service'),
  APP_KEYCLOAK_ADMIN_CLIENT_SECRET: z.string().min(1),
});

export type AppConfig = z.infer<typeof EnvSchema>;

export const loadConfig = (
  environment: Record<string, string | undefined> = process.env,
): AppConfig => {
  const config = EnvSchema.parse(secretEnvironment(environment));
  if (config.APP_IDENTITY_ENVIRONMENT === 'production' && !config.APP_REQUIRE_ADMIN_PASSKEY) throw new Error('Production administration requires passkeys.');
  if (config.APP_IDENTITY_ENVIRONMENT !== 'local' && config.APP_GITHUB_API_URL !== 'https://api.github.com') throw new Error('Custom GitHub endpoints are restricted to the local laboratory.');
  return config;
};
