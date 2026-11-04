import { Request } from 'express';
import rateLimit from 'express-rate-limit';
import { config } from '../config';

// Coarse per-user request limiter in front of the deploy endpoints. It only protects the API and database from
// being hammered; the real "5 deployments per hour" rule is the database-backed one in services/quota.ts.
export const deployBurstLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: config.deployBurstPerMin,
  keyGenerator: (req: Request) => req.user?.id ?? req.ip ?? 'anonymous',
  handler: (_req, res) => {
    res.status(429).set('Retry-After', '60').json({ error: 'Too many requests, slow down', code: 'TOO_MANY_REQUESTS' });
  },
});
