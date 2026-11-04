import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { config } from '../config';
import { prisma } from '../db';
import { HttpError } from '../lib/errors';
import { authenticate, signToken } from '../middleware/auth';

export const authRouter = Router();

const creds = z.object({
  email: z.string().email().toLowerCase(),
  password: z.string().min(8).max(128),
});

const registerBody = creds.extend({ inviteCode: z.string().max(200).optional() });

const sha = (v: string) => crypto.createHash('sha256').update(v).digest();
const sameSecret = (a: string, b: string) => crypto.timingSafeEqual(sha(a), sha(b));

// Per-IP hourly cap on NEW accounts (demo mode only). Login attempts are limited separately in app.ts.
const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: config.demo.registration.perIpPerHour,
  skip: () => !config.demo.enabled,
  handler: (_req, res) => {
    res.status(429).set('Retry-After', '3600').json({ error: 'Too many accounts created from this address. Try again later.', code: 'REGISTER_RATE_LIMITED' });
  },
});

// What the sign-up form needs to know.
authRouter.get('/config', async (_req, res) => {
  const full = config.demo.enabled && (await prisma.user.count()) >= config.demo.registration.maxUsers;
  res.json({
    demoMode: config.demo.enabled,
    registrationOpen: !full,
    inviteRequired: config.demo.enabled && !!config.demo.registration.inviteCode,
  });
});

const publicUser = (u: { id: string; email: string; role: string; createdAt: Date }) => ({
  id: u.id,
  email: u.email,
  role: u.role,
  createdAt: u.createdAt,
});

// Normal mode: the first account created becomes ADMIN; everyone after is USER.
// Demo mode (public): registration NEVER grants ADMIN, because on a fresh public instance "first" would be a stranger.
// Create the operator with `node dist/scripts/createAdmin.js`. Sign-up can also require an invite code and is capped.
authRouter.post('/register', registerLimiter, async (req, res) => {
  const { email, password, inviteCode } = registerBody.parse(req.body);
  const total = await prisma.user.count();
  if (config.demo.enabled) {
    const required = config.demo.registration.inviteCode;
    if (required && !(inviteCode && sameSecret(inviteCode, required))) {
      throw new HttpError(403, 'A valid invite code is required to register', { code: 'INVITE_REQUIRED' });
    }
    // Soft cap: two simultaneous sign-ups right at the limit could overshoot it by a few accounts.
    if (total >= config.demo.registration.maxUsers) {
      throw new HttpError(403, 'This demo has reached its account limit. Ask the owner for access.', { code: 'REGISTRATION_CLOSED' });
    }
  }
  if (await prisma.user.findUnique({ where: { email } })) throw new HttpError(409, 'Email already registered');
  const role = !config.demo.enabled && total === 0 ? 'ADMIN' : 'USER';
  const user = await prisma.user.create({
    data: { email, passwordHash: await bcrypt.hash(password, 12), role },
  });
  res.status(201).json({ token: signToken(user), user: publicUser(user) });
});

authRouter.post('/login', async (req, res) => {
  const { email, password } = creds.parse(req.body);
  const user = await prisma.user.findUnique({ where: { email } });
  const ok = user && (await bcrypt.compare(password, user.passwordHash));
  if (!user || !ok) throw new HttpError(401, 'Invalid credentials');
  res.json({ token: signToken(user), user: publicUser(user) });
});

authRouter.get('/me', authenticate, async (req, res) => {
  const user = await prisma.user.findUnique({ where: { id: req.user!.id } });
  res.json(publicUser(user!));
});
