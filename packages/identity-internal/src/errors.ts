import { ZodError } from 'zod';
import type { ErrorRequestHandler } from 'express';

export class HttpError extends Error {
  public constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export const errorHandler: ErrorRequestHandler = (error, request, response, _next) => {
  void _next;
  const requestId = response.getHeader('x-request-id');
  const isHttpError = error instanceof HttpError;
  const status = isHttpError
    ? error.status
    : error instanceof ZodError || error instanceof SyntaxError
      ? 400
      : 500;
  const code = isHttpError
    ? error.code
    : error instanceof ZodError || error instanceof SyntaxError
      ? 'invalid_input'
      : 'internal_error';

  if (status >= 500) {
    console.error(
      JSON.stringify({
        level: 'error',
        message: 'unhandled request error',
        request_id: requestId,
        method: request.method,
        path: request.path,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  }

  response.status(status).json({
    error: {
      code,
      message: isHttpError
        ? error.message
        : error instanceof ZodError || error instanceof SyntaxError
          ? 'Invalid input. Check the submitted fields.'
          : 'Unexpected server error.',
    },
    request_id: requestId,
  });
};
