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
  APP_REQUIRE_ADMIN_PASSKEY: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),
  APP_PORT: z.coerce.number().int().positive().default(8080),
  APP_LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  APP_CORS_ORIGINS: z.preprocess(parseOrigins, z.array(z.string().url()).min(1)),
  APP_SERVICE_VERSION: z.string().default('0.1.0'),
  APP_KEYCLOAK_ISSUER: z.string().url(),
  APP_KEYCLOAK_TRANSPORT_URL: z.string().url().optional(),
  APP_KEYCLOAK_ADMIN_URL: z.string().url(),
  APP_KEYCLOAK_REALM: z.string().min(1),
  APP_ACCOUNT_AUDIENCE: z.literal('identity-account-api').default('identity-account-api'),
  APP_KEYCLOAK_ADMIN_CLIENT_ID: z
    .literal('identity-account-service')
    .default('identity-account-service'),
  APP_KEYCLOAK_ADMIN_CLIENT_SECRET: z.string().min(1),
  APP_ACCOUNT_CLIENT_ID: z.string().default('identity-account-web'),
  APP_ACCOUNT_PUBLIC_URL: z.string().url(),
  APP_ACTIVATION_LIFESPAN_SECONDS: z.coerce.number().int().min(300).max(86400).default(3600),
  APP_AVATAR_DIRECTORY: z.string().min(1).optional(),
  APP_AVATAR_BUCKET: z.string().min(3).optional(),
  APP_AVATAR_REGION: z.string().default('eu-south-2'),
  APP_AVATAR_ENDPOINT: z.string().url().optional(),
  APP_AVATAR_FORCE_PATH_STYLE: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
});
export type AppConfig = z.infer<typeof EnvSchema>;
export const loadConfig = (
  environment: Record<string, string | undefined> = process.env,
): AppConfig => EnvSchema.parse(secretEnvironment(environment));
