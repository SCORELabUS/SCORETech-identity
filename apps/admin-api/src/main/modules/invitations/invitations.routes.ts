import { Router, type ErrorRequestHandler } from 'express';
import { z } from 'zod';
import type { AppConfig } from '../../config/app-config.js';
import { HttpError } from '../../shared/http/errors.js';
import { asyncHandler } from '../../shared/http/async-handler.js';
import type { Principal } from '../auth/oidc-authenticator.js';
import { hasIdentityOperationPolicy } from '../../shared/identity-policies.js';
import type { Logger } from '../../shared/logging/logger.js';
const Id = z.string().uuid();
const Name = z
  .string({ required_error: 'Enter a name.', invalid_type_error: 'Enter a valid name.' })
  .trim()
  .min(1, 'Enter a name.')
  .max(150, 'The name cannot exceed 150 characters.');
const Limit = z
  .number({
    required_error: 'Enter the registration limit.',
    invalid_type_error: 'The registration limit must be a number.',
  })
  .int('The registration limit must be an integer.')
  .min(1, 'Allow at least one registration.')
  .max(100000, 'The limit cannot exceed 100000 registrations.');
const Expires = z
  .number({ invalid_type_error: 'Enter a valid date and time.' })
  .int('Enter a valid date and time.')
  .positive('Enter a valid date and time.')
  .nullable()
  .refine(
    (value) => value === null || value > Date.now(),
    'The expiry date must be in the future.',
  );
class InvitationInputError extends HttpError {
  constructor(public readonly fields: Record<string, string[]>) {
    super(
      400,
      'invalid_input',
      fields.form?.join(' ') ?? 'Review the highlighted fields before continuing.',
    );
  }
}
function parseInput<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const fields: Record<string, string[]> = {};
  for (const issue of result.error.issues) {
    const field = issue.path[0]?.toString() ?? 'form';
    (fields[field] ??= []).push(issue.message);
  }
  throw new InvitationInputError(fields);
}
const Page = z
  .object({
    first: z.coerce.number().int().min(0).max(10000).default(0),
    max: z.coerce.number().int().min(1).max(100).default(25),
    state: z.enum(['active', 'expired', 'revoked', 'exhausted', 'blocked']).optional(),
    search: z.string().trim().max(150).optional(),
  })
  .strict();
export const InvitationSchema = z.object({
  id: Id,
  environment: z.enum(['local', 'staging', 'production']),
  name: Name,
  roles: z.string().array(),
  limit: Limit,
  completed: z.number().int().nonnegative(),
  available: z.number().int().nonnegative(),
  creator: z.string(),
  createdAt: z.number(),
  // Keycloak omits null map entries on the wire. Keep a stable nullable API shape.
  expiresAt: z
    .number()
    .nullish()
    .transform((value) => value ?? null),
  revokedAt: z
    .number()
    .nullish()
    .transform((value) => value ?? null),
  state: z.enum(['active', 'expired', 'revoked', 'exhausted', 'blocked']),
  version: z.number().int().nonnegative(),
});
export async function providerRequest(
  config: AppConfig,
  token: string,
  path: string,
  method: string,
  body?: unknown,
): Promise<unknown> {
  const realmUrl = config.APP_KEYCLOAK_TRANSPORT_URL ?? config.APP_KEYCLOAK_ISSUER;
  const response = await fetch(`${realmUrl.replace(/\/$/, '')}/${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(15000),
    redirect: 'error',
  });
  if (!response.ok)
    throw new HttpError(
      response.status >= 500 ? 503 : response.status,
      response.status === 403
        ? 'insufficient_permission'
        : response.status === 409
          ? 'invitation_conflict'
          : response.status === 404
            ? 'not_found'
            : 'provider_operation_failed',
      response.status === 403
        ? 'You cannot perform this operation or delegate the selected roles.'
        : response.status === 409
          ? 'The invitation has changed or is unavailable. Refresh its details.'
          : response.status === 404
            ? 'Invitation not found.'
            : 'The operation could not be completed in SCORETech Identity.',
    );
  return response.status === 204 ? undefined : await response.json();
}
export function createInvitationsRouter(config: AppConfig, logger: Logger): Router {
  const router = Router();
  const parseProvider = <T>(schema: z.ZodType<T>, value: unknown): T => {
    const parsed = schema.safeParse(value);
    if (parsed.success) return parsed.data;
    logger.warn('invalid invitation provider response', {
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        code: issue.code,
      })),
    });
    throw new HttpError(
      502,
      'invalid_provider_response',
      'SCORETech Identity returned incompatible data. Check the invitation list before retrying.',
    );
  };
  router.use((request, response, next) => {
    const principal = response.locals.principal as Principal;
    const operation =
      request.method === 'GET'
        ? 'view'
        : request.method === 'DELETE'
          ? 'delete'
          : request.method === 'PATCH'
            ? 'update'
            : request.path.endsWith('/revoke')
              ? 'revoke'
              : 'create';
    if (
      !hasIdentityOperationPolicy(
        principal.roles,
        `identity:invitations:${operation}`,
        config.APP_IDENTITY_ENVIRONMENT,
      )
    )
      return next(new HttpError(403, 'insufficient_permission', 'Invitation permission required.'));
    if (
      operation === 'create' &&
      !hasIdentityOperationPolicy(
        principal.roles,
        'identity:users:update:roles',
        config.APP_IDENTITY_ENVIRONMENT,
      )
    )
      return next(
        new HttpError(403, 'insufficient_permission', 'Role assignment permission required.'),
      );
    next();
  });
  const call = (token: string, path: string, method: string, body?: unknown) =>
    providerRequest(config, token, `tentu-invitations${path}`, method, body);
  const token = (request: { get(name: string): string | undefined }) =>
    request.get('authorization')!.slice(7);
  const audit = (locals: Record<string, unknown>, action: string, id: string) =>
    logger.info('invitation operation', {
      audit: true,
      actor_id: (locals.principal as Principal).subject,
      action,
      invitation_id: id,
    });
  router.post(
    '/',
    asyncHandler(async (req, res) => {
      const body = parseInput(
        z
          .object({
            name: Name,
            roles: z
              .array(
                z
                  .string({ invalid_type_error: 'Select a valid role.' })
                  .min(1, 'Select a valid role.')
                  .max(150, 'The role cannot exceed 150 characters.'),
                {
                  required_error: 'Select at least one role.',
                  invalid_type_error: 'Select valid roles.',
                },
              )
              .min(1, 'Select at least one role.')
              .max(50, 'Select no more than fifty roles.')
              .refine(
                (roles) => new Set(roles).size === roles.length,
                'Do not select a role twice.',
              ),
            limit: Limit,
            expiresAt: Expires.optional(),
          })
          .strict(),
        req.body,
      );
      const data = parseProvider(
        z.object({ invitation: InvitationSchema, link: z.string().url() }),
        await call(token(req), '', 'POST', body),
      );
      const link = new URL(data.link);
      const issuer = new URL(config.APP_KEYCLOAK_ISSUER);
      if (
        link.origin !== issuer.origin ||
        link.pathname !== `${issuer.pathname}/tentu-invitations/join` ||
        !/^#[A-Za-z0-9_-]{43}$/.test(link.hash) ||
        data.invitation.environment !== config.APP_IDENTITY_ENVIRONMENT
      )
        throw new HttpError(502, 'invalid_provider_response', 'Invalid invitation link.');
      audit(res.locals, 'create', data.invitation.id);
      res.status(201).json(data);
    }),
  );
  router.get(
    '/',
    asyncHandler(async (req, res) => {
      const page = Page.parse(req.query);
      const query = new URLSearchParams({
        first: String(page.first),
        max: String(page.max),
        ...(page.state ? { state: page.state } : {}),
        ...(page.search ? { search: page.search } : {}),
      });
      res.json(
        z
          .object({ invitations: InvitationSchema.array() })
          .parse(await call(token(req), `?${query.toString()}`, 'GET')),
      );
    }),
  );
  router.get(
    '/:id',
    asyncHandler(async (req, res) => {
      res.json(
        InvitationSchema.parse(await call(token(req), `/${Id.parse(req.params.id)}`, 'GET')),
      );
    }),
  );
  router.patch(
    '/:id',
    asyncHandler(async (req, res) => {
      const id = Id.parse(req.params.id);
      const body = parseInput(
        z
          .object({
            name: Name.optional(),
            limit: Limit.optional(),
            expiresAt: Expires.optional(),
            version: z
              .number({
                required_error: 'The invitation version is missing. Refresh its details.',
                invalid_type_error: 'The invitation version is invalid.',
              })
              .int('The invitation version is invalid.')
              .nonnegative('The invitation version is invalid.'),
          })
          .strict()
          .refine(
            (value) =>
              value.name !== undefined ||
              value.limit !== undefined ||
              value.expiresAt !== undefined,
            'Change at least one field before saving.',
          ),
        req.body,
      );
      const data = parseProvider(InvitationSchema, await call(token(req), `/${id}`, 'PATCH', body));
      audit(res.locals, 'update', id);
      res.json(data);
    }),
  );
  router.delete(
    '/:id',
    asyncHandler(async (req, res) => {
      const id = Id.parse(req.params.id);
      await call(token(req), `/${id}`, 'DELETE');
      audit(res.locals, 'delete', id);
      res.status(204).end();
    }),
  );
  router.post(
    '/:id/revoke',
    asyncHandler(async (req, res) => {
      const id = Id.parse(req.params.id);
      const data = InvitationSchema.parse(await call(token(req), `/${id}/revoke`, 'POST'));
      audit(res.locals, 'revoke', id);
      res.json(data);
    }),
  );
  router.get(
    '/:id/users',
    asyncHandler(async (req, res) => {
      const page = Page.omit({ state: true }).parse(req.query);
      const id = Id.parse(req.params.id);
      res.json(
        z
          .object({
            users: z.array(
              z.object({
                id: Id,
                email: z
                  .string()
                  .nullish()
                  .transform((value) => value ?? null),
                registeredAt: z.number(),
                roles: z.string().array(),
                catalogueRevision: z.string(),
              }),
            ),
          })
          .parse(await call(token(req), `/${id}/users?first=${page.first}&max=${page.max}`, 'GET')),
      );
    }),
  );
  const fieldErrors: ErrorRequestHandler = (error, _req, res, next) => {
    if (!(error instanceof InvitationInputError)) return next(error);
    res.status(error.status).json({
      error: { code: error.code, message: error.message, fields: error.fields },
      request_id: res.getHeader('x-request-id'),
    });
  };
  router.use(fieldErrors);
  return router;
}
