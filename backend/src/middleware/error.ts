import { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import { HttpError } from '../lib/errors';

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof ZodError) {
    return res.status(400).json({ error: 'Validation failed', details: err.flatten().fieldErrors });
  }
  if (err instanceof HttpError) {
    if (err.extra.headers) res.set(err.extra.headers);
    return res.status(err.status).json({ error: err.message, ...(err.extra.code ? { code: err.extra.code } : {}), ...(err.extra.data ?? {}) });
  }
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
}
