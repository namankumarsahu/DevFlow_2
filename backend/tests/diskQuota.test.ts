process.env.NODE_ENV = 'test';
process.env.DEMO_MODE = 'true';
process.env.STORAGE_QUOTA = 'true'; // the administrator CLAIMS quotas work

import request from 'supertest';
jest.mock('../src/db', () => ({ prisma: require('./helpers/db').db }));
jest.mock('../src/queue', () => ({ getQueue: () => require('./helpers/db').queue }));
jest.mock('../src/redis', () => ({ getRedis: () => require('./helpers/db').redis, createRedis: () => require('./helpers/db').redis }));
import { createApp } from '../src/app';
import { interpretStorageProbe } from '../src/lib/storageQuota';
import { signToken } from '../src/middleware/auth';
import { db, redisValues } from './helpers/db';

const app = createApp();
const auth = () => `Bearer ${signToken({ id: 'alice', role: 'USER' })}`;
beforeEach(() => { db.tables.user = []; db.seedUser('alice'); redisValues.clear(); });

describe('disk quota is only shown as enforced after the worker proved it', () => {
  it('claim without proof -> not enforced', async () => {
    expect((await request(app).get('/api/projects/limits').set('Authorization', auth())).body.diskQuotaEnforced).toBe(false);
  });
  it('proof from the worker -> enforced', async () => {
    redisValues.set('devflow:storage-quota', 'verified');
    expect((await request(app).get('/api/projects/limits').set('Authorization', auth())).body.diskQuotaEnforced).toBe(true);
  });
  it('worker says unsupported -> not enforced', async () => {
    redisValues.set('devflow:storage-quota', 'unsupported');
    expect((await request(app).get('/api/projects/limits').set('Authorization', auth())).body.diskQuotaEnforced).toBe(false);
  });
  it('interprets the docker probe', () => {
    expect(interpretStorageProbe(0, '')).toBe(true);
    expect(interpretStorageProbe(125, "--storage-opt is supported only for overlay over xfs with 'pquota' mount option")).toBe(false);
    expect(interpretStorageProbe(125, 'pull access denied')).toBe(false); // could not prove it -> off
  });
});
