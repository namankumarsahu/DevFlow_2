process.env.NODE_ENV = 'test';
process.env.DEMO_MODE = 'true';
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import request from 'supertest';
jest.mock('../src/db', () => ({ prisma: require('./helpers/db').db }));
jest.mock('../src/queue', () => ({ getQueue: () => require('./helpers/db').queue }));
jest.mock('../src/redis', () => ({ createRedis: () => ({}), getRedis: () => require('./helpers/db').redis }));
jest.mock('../src/lib/runProcess', () => ({ runProcess: jest.fn() }));
import { createApp } from '../src/app';
import { config } from '../src/config';
import { signToken } from '../src/middleware/auth';
import { db, queue } from './helpers/db';
import { runProcess } from '../src/lib/runProcess';
const app = createApp();
const auth = (id = 'owner', role = 'USER') => `Bearer ${signToken({ id, role } as any)}`;
let tmp: string;
beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'df-preflight-api-')); config.workDir = tmp;
  for (const key of Object.keys(db.tables)) db.tables[key] = [];
  jest.clearAllMocks(); db.seedUser('owner'); db.seedProject('project', 'owner');
  (runProcess as jest.Mock).mockImplementation(async opts => {
    const repo = opts.args.at(-1); await mkdir(repo, { recursive: true });
    await writeFile(path.join(repo, 'package.json'), '{"scripts":{"start":"node server.js"}}');
    await writeFile(path.join(repo, 'server.js'), 'server.listen(4173,"127.0.0.1");');
    return { outcome: 'ok', code: 0, pid: 1 };
  });
});
afterEach(async () => { await rm(tmp, { recursive: true, force: true }); });
it('checks a shallow bounded clone, stores findings and caches identical checks', async () => {
  const response = await request(app).post('/api/projects/project/preflight').set('Authorization', auth()).send({});
  expect(response.status).toBe(200); expect(response.body.status).toBe('unsupported');
  expect(db.tables.project[0].preflightKey).toBeTruthy();
  expect((runProcess as jest.Mock).mock.calls[0][0]).toMatchObject({ cmd: 'git', timeoutMs: 60000, watchDirectory: { maxBytes: config.maxRepoMb * 1024 * 1024 } });
  expect((runProcess as jest.Mock).mock.calls[0][0].args).toEqual(expect.arrayContaining(['--depth','1','--no-recurse-submodules']));
  expect((await request(app).post('/api/projects/project/preflight').set('Authorization', auth()).send({})).status).toBe(200);
  expect(runProcess).toHaveBeenCalledTimes(1);
});
it('prevents known blockers from using a deployment attempt and rejects user overrides', async () => {
  await request(app).post('/api/projects/project/preflight').set('Authorization', auth()).send({});
  const response = await request(app).post('/api/projects/project/deploy').set('Authorization', auth()).send({});
  expect(response.status).toBe(422); expect(response.body.code).toBe('PREFLIGHT_BLOCKED');
  expect(db.tables.deploymentAttempt).toHaveLength(0); expect(queue.add).not.toHaveBeenCalled();
  expect((await request(app).post('/api/projects/project/deploy').set('Authorization', auth()).send({ overridePreflight: true })).status).toBe(403);
});
it('permits an explicit admin override while keeping owner quotas', async () => {
  await request(app).post('/api/projects/project/preflight').set('Authorization', auth()).send({});
  db.seedUser('admin', 'ADMIN');
  const response = await request(app).post('/api/projects/project/deploy').set('Authorization', auth('admin','ADMIN')).send({ overridePreflight: true });
  expect(response.status).toBe(202); expect(response.body.preflightOverride).toBe(true);
  expect(db.tables.deploymentAttempt).toHaveLength(1);
});
it('persists reviewed plan identity and rejects a different review before consuming an attempt', async () => {
  (runProcess as jest.Mock).mockImplementation(async opts => {
    const repo = opts.args.at(-1); await mkdir(repo, { recursive: true });
    await writeFile(path.join(repo, 'package.json'), '{"scripts":{"start":"node server.js"}}');
    await writeFile(path.join(repo, 'server.js'), 'server.listen(process.env.PORT,"0.0.0.0");');
    return { outcome: 'ok', code: 0, pid: 1 };
  });
  const review = await request(app).post('/api/projects/project/preflight').set('Authorization', auth()).send({});
  expect(review.body.plan).toMatchObject({ version: 1, scope: 'web-service', limits: { memoryMb: 256, cpus: 0.25 } });
  const stale = await request(app).post('/api/projects/project/deploy').set('Authorization', auth()).send({ planId: '0'.repeat(64) });
  expect(stale.status).toBe(409); expect(db.tables.deploymentAttempt).toHaveLength(0);
  const deploy = await request(app).post('/api/projects/project/deploy').set('Authorization', auth()).send({ planId: review.body.plan.id });
  expect(deploy.status).toBe(202); expect(deploy.body.preflight.reviewedPlanId).toBe(review.body.plan.id);
});
it('keeps access checks ahead of cloning and returns bounded-clone failures as findings', async () => {
  db.seedUser('other'); db.seedProject('private', 'other');
  expect((await request(app).post('/api/projects/private/preflight').set('Authorization', auth()).send({})).status).toBe(404);
  expect(runProcess).not.toHaveBeenCalled();
  (runProcess as jest.Mock).mockResolvedValue({ outcome: 'too-large', code: null });
  const response = await request(app).post('/api/projects/project/preflight').set('Authorization', auth()).send({});
  expect(response.body.findings[0]).toMatchObject({ id: 'repo.clone', severity: 'blocker' });
});
it.each([
  { plan: { healthPath: '/ready', healthMode: 'readiness' } },
  { rollbackHealthPath: '/ready', rollbackHealthMode: 'readiness' },
])('allows rollback using recorded health settings even when the current repository preflight is blocked: %j', async recorded => {
  await request(app).post('/api/projects/project/preflight').set('Authorization', auth()).send({});
  db.seedDeployment('old', 'project', 'SUCCESS', { imageTag: 'devflow/project:old', preflight: recorded });
  const response = await request(app).post('/api/deployments/old/rollback').set('Authorization', auth()).send({});
  expect(response.status).toBe(202);
  expect(response.body.preflight.rollbackHealthPath).toBe('/ready');
  expect(response.body.preflight.rollbackHealthMode).toBe('readiness');
  expect(db.tables.deploymentAttempt).toHaveLength(1);
});
