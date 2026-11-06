import { hasIdentityOperationPolicy } from '../../shared/identity-policies.js';
import type { RequestHandler } from 'express';
import { HttpError, type Principal } from '@scoretech/identity-internal';
export const authorizeIdentityOperation: RequestHandler = (request, response, next) => {
  const roles = (response.locals.principal as Principal).roles;
  const permissions: string[] = [];
  const path = request.path;
  if (request.method === 'GET' && path === '/support-assurance') {
    // Own authentication status; entry authorization has already been checked.
  } else if (/^\/users\/[^/]+\/recovery(?:\/[^/]+)?$/.test(path)) {
    permissions.push(
      request.method === 'GET'
        ? 'identity:users:recovery:view'
        : request.method === 'POST'
          ? 'identity:users:recovery:create'
          : 'identity:users:recovery:revoke',
    );
  } else if (request.method === 'GET')
    permissions.push(
      path.endsWith('/credentials')
        ? 'identity:users:credentials:view'
        : path === '/roles'
          ? 'identity:roles:view'
          : 'identity:users:view',
    );
  else if (request.method === 'DELETE' && /^\/users\/[^/]+\/credentials\/[^/]+$/.test(path))
    permissions.push('identity:users:credentials:delete');
  else if (request.method === 'DELETE' && /^\/users\/[^/]+\/sessions\/[^/]+$/.test(path))
    permissions.push('identity:users:logout');
  else if (request.method === 'POST' && path === '/users') {
    permissions.push('identity:users:create');
    if ((request.body as { sendVerifyEmail?: boolean } | undefined)?.sendVerifyEmail)
      permissions.push('identity:users:send-verification');
  } else if (request.method === 'PATCH' && /^\/users\/[^/]+$/.test(path)) {
    const body = request.body as Record<string, unknown> | undefined;
    if (body && ('firstName' in body || 'lastName' in body))
      permissions.push('identity:users:update:name');
    if (body && 'email' in body) permissions.push('identity:users:update:email');
    if (body && 'enabled' in body)
      permissions.push(
        body.enabled === true ? 'identity:users:activate' : 'identity:users:deactivate',
      );
  } else if (request.method === 'DELETE' && /^\/users\/[^/]+$/.test(path))
    permissions.push('identity:users:delete');
  else if (path.endsWith('/roles') || path === '/users/roles/batch')
    permissions.push('identity:users:update:roles');
  else if (path.endsWith('/password')) permissions.push('identity:users:update:password');
  else if (path.endsWith('/send-password-reset'))
    permissions.push('identity:users:send-password-reset');
  else if (path.endsWith('/send-verification'))
    permissions.push('identity:users:send-verification');
  else if (path.endsWith('/send-activation')) permissions.push('identity:users:send-verification');
  else if (path.endsWith('/logout')) permissions.push('identity:users:logout');
  if (
    permissions.some(
      (permission) =>
        !hasIdentityOperationPolicy(
          roles,
          permission,
          String(response.locals.identityEnvironment ?? 'staging'),
        ),
    )
  ) {
    next(new HttpError(403, 'insufficient_permission', 'Required identity permission missing.'));
    return;
  }
  next();
};
