import type { RequestHandler } from 'express';

/** Track the actual handler lifetime, including writes finishing after disconnect. */
export const asyncHandler =
  (handler: RequestHandler): RequestHandler =>
  (request, response, next) => {
    const end = (response.locals.beginIdentityOperation as (() => () => void) | undefined)?.();
    Promise.resolve()
      .then(() => handler(request, response, next))
      .then(
        () => end?.(),
        (error: unknown) => {
          end?.();
          next(error);
        },
      );
  };
