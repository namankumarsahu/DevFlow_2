process.env.NODE_ENV = 'test';
process.env.DEMO_MODE = 'true';
process.env.REGISTER_PER_IP_HOUR = '3';

import request from 'supertest';
jest.mock('../src/db', () => ({ prisma: require('./helpers/db').db }));
jest.mock('../src/queue', () => ({ getQueue: () => require('./helpers/db').queue }));
jest.mock('../src/redis', () => ({ getRedis: () => require('./helpers/db').redis, createRedis: () => require('./helpers/db').redis }));
import { createApp } from '../src/app';
import { db } from './helpers/db';

const app = createApp();

it('rate limits sign-ups per address (3 per hour here)', async () => {
  const codes: number[] = [];
  for (let i = 0; i < 5; i++) {
    db.tables.user = [];
    codes.push((await request(app).post('/api/auth/register').send({ email: `n${i}@x.co`, password: 'password123' })).status);
  }
  expect(codes).toEqual([201, 201, 201, 429, 429]);
});
