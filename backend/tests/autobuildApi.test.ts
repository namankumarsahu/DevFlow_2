process.env.NODE_ENV = 'test';
process.env.DEMO_MODE = 'true';

import request from 'supertest';
jest.mock('../src/db', () => ({ prisma: require('./helpers/db').db }));
jest.mock('../src/queue', () => ({ getQueue: () => require('./helpers/db').queue }));
jest.mock('../src/redis', () => ({ createRedis: () => ({}), getRedis: () => require('./helpers/db').redis }));
import { createApp } from '../src/app';
import { signToken } from '../src/middleware/auth';
import { db } from './helpers/db';
const app = createApp();
const auth = () => `Bearer ${signToken({ id: 'owner', role: 'USER' })}`;
beforeEach(() => {
  for (const key of Object.keys(db.tables)) db.tables[key] = [];
  db.seedUser('owner'); db.seedProject('project', 'owner');
});
it('defaults new projects to AUTO with nullable overrides for existing behavior', async () => {
  const res = await request(app).post('/api/projects').set('Authorization', auth()).send({ name: 'Auto', repoUrl: 'https://github.com/o/r' });
  expect(res.status).toBe(201);
  expect(res.body).toMatchObject({ buildMode: 'AUTO', preset: null, startCommand: null, buildCommand: null });
});
it('lets a demo user save presets and commands without widening resource limits', async () => {
  const settings = { buildMode: 'AUTO', preset: 'NODE', startCommand: 'node "server.js"', buildCommand: 'npm run build' };
  const res = await request(app).patch('/api/projects/project').set('Authorization', auth()).send(settings);
  expect(res.status).toBe(200); expect(res.body).toMatchObject(settings);
  const bad = await request(app).patch('/api/projects/project').set('Authorization', auth()).send({ ...settings, memoryMb: 512 });
  expect(bad.status).toBe(400);
});
it.each(['a\nFROM evil', 'a\rRUN x', 'x\0y', 'x\x7fy', 'x\u2028y', 'x\u2029y', 'x'.repeat(1001), '  '])('validates commands on both create and update', async (value) => {
  const patch = await request(app).patch('/api/projects/project').set('Authorization', auth()).send({ startCommand: value });
  expect(patch.status).toBe(400);
  const create = await request(app).post('/api/projects').set('Authorization', auth()).send({ name: 'Bad', repoUrl: 'https://github.com/o/r', buildCommand: value });
  expect(create.status).toBe(400);
});
it('rejects unknown enum values and preserves ownership checks', async () => {
  expect((await request(app).patch('/api/projects/project').set('Authorization', auth()).send({ preset: 'SHELL' })).status).toBe(400);
  db.seedUser('other'); db.seedProject('private', 'other');
  expect((await request(app).patch('/api/projects/private').set('Authorization', auth()).send({ preset: 'STATIC' })).status).toBe(404);
});
