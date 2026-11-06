import { Counter, Registry, collectDefaultMetrics } from 'prom-client';
import type { RequestHandler } from 'express';

export const createMetrics = (
  service = 'identity-admin-api',
): { middleware: RequestHandler; handler: RequestHandler } => {
  const registry = new Registry();
  collectDefaultMetrics({ register: registry });
  const requests = new Counter({
    name: `${service.replaceAll('-', '_')}_http_requests_total`,
    help: `HTTP requests completed by ${service}.`,
    labelNames: ['method', 'status_code'] as const,
    registers: [registry],
  });

  return {
    middleware: (request, response, next) => {
      response.on('finish', () =>
        requests.inc({ method: request.method, status_code: String(response.statusCode) }),
      );
      next();
    },
    handler: async (_request, response) => {
      response.setHeader('Content-Type', registry.contentType);
      response.send(await registry.metrics());
    },
  };
};
