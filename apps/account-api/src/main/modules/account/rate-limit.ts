import type { RequestHandler } from 'express';
import { HttpError, type Principal } from '@scoretech/identity-internal';
/** Per-replica abuse bound, keyed by the verified subject. */
export const createAccountRateLimit = (
  limit: number,
  windowMs: number,
  now = Date.now,
): RequestHandler => {
  const entries = new Map<string, { count: number; expiresAt: number }>();
  let nextSweep = 0;
  return (_request, response, next) => {
    const time = now();
    if (time >= nextSweep) {
      for (const [key, value] of entries) if (value.expiresAt <= time) entries.delete(key);
      nextSweep = time + 60_000;
    }
    const subject = (response.locals.principal as Principal).subject;
    let entry = entries.get(subject);
    if (!entry || entry.expiresAt <= time) {
      if (entries.size >= 10_000) {
        next(new HttpError(503, 'rate_limit_capacity', 'Please retry later.'));
        return;
      }
      entry = { count: 0, expiresAt: time + windowMs };
      entries.set(subject, entry);
    }
    if (entry.count >= limit) {
      response.setHeader('Retry-After', Math.ceil((entry.expiresAt - time) / 1000));
      next(new HttpError(429, 'rate_limited', 'Too many requests. Please retry later.'));
      return;
    }
    entry.count++;
    next();
  };
};
