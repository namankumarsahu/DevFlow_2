process.env.NODE_ENV = 'test';
process.env.DEMO_MODE = 'true';
process.env.REGISTRATION_INVITE_CODE = 'let-me-in';
process.env.DEMO_MAX_USERS = '4';
process.env.REGISTER_PER_IP_HOUR = '100';

import request from 'supertest';
jest.mock('../src/db', () => ({ prisma: require('./helpers/db').db }));
jest.mock('../src/queue', () => ({ getQueue: () => require('./helpers/db').queue }));
jest.mock('../src/redis', () => ({ getRedis: () => require('./helpers/db').redis, createRedis: () => require('./helpers/db').redis }));
import { createApp } from '../src/app';
import { db } from './helpers/db';

const app = createApp();
beforeEach(() => { db.tables.user = []; });
const reg = (email: string, inviteCode?: string) => request(app).post('/api/auth/register').send({ email, password: 'password123', inviteCode });

describe('public demo registration', () => {
  it('requires the invite code', async () => {
    expect((await reg('a@x.co')).status).toBe(403);
    const wrong = await reg('a@x.co', 'nope');
    expect(wrong.status).toBe(403);
    expect(wrong.body.code).toBe('INVITE_REQUIRED');
    expect(db.tables.user).toHaveLength(0);
  });
  it('never makes a public sign-up an admin, not even the first one', async () => {
    const res = await reg('first@x.co', 'let-me-in');
    expect(res.status).toBe(201);
    expect(res.body.user.role).toBe('USER');
  });
  it('advertises what the form needs', async () => {
    const res = await request(app).get('/api/auth/config');
    expect(res.body).toEqual({ demoMode: true, registrationOpen: true, inviteRequired: true });
  });
  it('stops at the account cap, and says so', async () => {
    for (let i = 0; i < 4; i++) db.seedUser(`u${i}`);
    const res = await reg('late@x.co', 'let-me-in');
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('REGISTRATION_CLOSED');
    expect((await request(app).get('/api/auth/config')).body.registrationOpen).toBe(false);
  });
});
