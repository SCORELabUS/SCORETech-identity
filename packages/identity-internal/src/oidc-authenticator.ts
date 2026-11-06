import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { RequestHandler } from 'express';
import { HttpError } from './errors.js';

const administrativeRoleNames = new Set([
  'administrador',
  'admin-web:local:access',
  'admin-web:staging:access',
  'admin-web:production:access',
]);

export interface Principal {
  subject: string;
  sessionId?: string;
  authTime?: number;
  stepUpScope?: string;
  authenticationMethod?: string;
  username?: string;
  roles: string[];
  // Live roles resolved by this request's passkey policy; never cached across requests.
  effectiveRoleNames?: string[];
}

interface OidcAuthenticatorOptions {
  issuer: string;
  transportUrl?: string;
  audience: string;
  requireAdmin?: boolean;
  requireSession?: boolean;
  requiredRoles?: string[];
  allowedClients?: string[];
  requireAdministrativePasskey?: boolean;
  effectiveRoles?: (subject: string) => Promise<string[]>;
}

export const createAdminAuthenticator = ({
  issuer,
  transportUrl,
  audience,
  requireAdmin = true,
  requireSession = false,
  requiredRoles = [],
  allowedClients,
  requireAdministrativePasskey = false,
  effectiveRoles,
}: OidcAuthenticatorOptions): RequestHandler => {
  const jwks = createRemoteJWKSet(
    new URL(`${(transportUrl ?? issuer).replace(/\/$/, '')}/protocol/openid-connect/certs`),
  );

  return async (request, response, next): Promise<void> => {
    try {
      const header = request.header('authorization');
      if (!header?.startsWith('Bearer '))
        throw new HttpError(401, 'missing_token', 'Bearer token required.');
      const { payload } = await jwtVerify(header.slice('Bearer '.length), jwks, {
        issuer,
        audience,
        requiredClaims: ['exp', 'sub', ...(requireSession ? ['sid'] : [])],
        algorithms: ['RS256'],
      });
      const roles = readRoles(payload.realm_access);
      if (requireAdmin && !roles.includes('administrador'))
        throw new HttpError(403, 'insufficient_role', 'Administrator role required.');
      if (requiredRoles.some((role) => !roles.includes(role)))
        throw new HttpError(403, 'insufficient_permission', 'Required permission missing.');
      if (
        allowedClients &&
        (typeof payload.azp !== 'string' || !allowedClients.includes(payload.azp))
      )
        throw new HttpError(403, 'client_not_allowed', 'Administrative client required.');
      if (
        requireSession &&
        (typeof payload.sid !== 'string' ||
          !payload.sid ||
          (typeof payload.preferred_username === 'string' &&
            payload.preferred_username.startsWith('service-account-')))
      )
        throw new HttpError(401, 'invalid_token', 'User session required.');
      const subject = payload.sub;
      if (!subject) throw new HttpError(401, 'invalid_token', 'Token subject is required.');
      let effectiveRoleNames: string[] | undefined;
      if (requireAdministrativePasskey) {
        effectiveRoleNames = effectiveRoles ? await effectiveRoles(subject) : undefined;
        const currentRoles = effectiveRoleNames ?? roles;
        if (
          (requireAdmin || currentRoles.some((role) => administrativeRoleNames.has(role))) &&
          (payload.tentu_auth_method !== 'webauthn-passwordless' ||
            payload.tentu_admin_verified !== true)
        )
          throw new HttpError(
            403,
            'administrative_passkey_required',
            'Verify your identity with a passkey.',
          );
      }
      response.locals.principal = {
        subject,
        sessionId: typeof payload.sid === 'string' ? payload.sid : undefined,
        stepUpScope: typeof payload.tentu_step_up === 'string' ? payload.tentu_step_up : undefined,
        authTime: typeof payload.auth_time === 'number' ? payload.auth_time : undefined,
        authenticationMethod:
          typeof payload.tentu_auth_method === 'string' ? payload.tentu_auth_method : undefined,
        username:
          typeof payload.preferred_username === 'string' ? payload.preferred_username : undefined,
        roles,
        ...(effectiveRoleNames ? { effectiveRoleNames } : {}),
      } satisfies Principal;
      next();
    } catch (error) {
      next(
        error instanceof HttpError
          ? error
          : new HttpError(401, 'invalid_token', 'Invalid or expired access token.'),
      );
    }
  };
};

const readRoles = (value: unknown): string[] => {
  if (!value || typeof value !== 'object' || !('roles' in value)) return [];
  const roles = (value as { roles?: unknown }).roles;
  return Array.isArray(roles)
    ? roles.filter((role): role is string => typeof role === 'string')
    : [];
};
