process.env.NODE_ENV = 'test';
process.env.DEMO_MODE = 'true';
process.env.DEPLOY_BURST_PER_MIN = '1000';

import request from 'supertest';
jest.mock('../src/db', () => ({ prisma: require('./helpers/db').db }));
jest.mock('../src/queue', () => ({ getQueue: () => require('./helpers/db').queue }));
jest.mock('../src/redis', () => ({ getRedis: () => require('./helpers/db').redis, createRedis: () => require('./helpers/db').redis }));

import { createApp } from '../src/app';
import { config } from '../src/config';
import { assertSafeRunArgs } from '../src/lib/dockerSafety';
import { assertSafeLimits, effectiveLimits, runLimitArgs } from '../src/lib/limits';
import { signToken } from '../src/middleware/auth';
import { db } from './helpers/db';

const app = createApp();
const bearer = (id: string, role: 'USER' | 'ADMIN' = 'USER') => `Bearer ${signToken({ id, role })}`;
const policy = { ...config.runtime, storageQuota: false };
const after = (a: string[], f: string) => a[a.indexOf(f) + 1];

beforeEach(() => {
  for (const t of Object.keys(db.tables)) db.tables[t] = [];
  db.seedUser('alice');
  db.seedUser('root', 'ADMIN');
});

describe('demo resource limits through the API', () => {
  it('creates projects with 256 MB / 0.25 CPU / 512 MB when the client sends nothing', async () => {
    const res = await request(app).post('/api/projects').set('Authorization', bearer('alice')).send({ name: 'x', repoUrl: 'https://github.com/o/r' });
    expect(res.status).toBe(201);
    expect(res.body.limits.effective).toEqual({ memoryMb: 256, cpus: 0.25, diskMb: 512 });
  });

  it('rejects client-supplied values above the maximum, on create and update', async () => {
    const create = await request(app).post('/api/projects').set('Authorization', bearer('alice')).send({ name: 'x', repoUrl: 'https://github.com/o/r', memoryMb: 2048 });
    expect(create.status).toBe(400);
    db.seedProject('p1', 'alice');
    for (const body of [{ memoryMb: 512 }, { cpus: 1 }, { diskMb: 5000 }]) {
      const res = await request(app).patch('/api/projects/p1').set('Authorization', bearer('alice')).send(body);
      expect(res.status).toBe(400);
    }
    expect(db.tables.project[0]).toMatchObject({ memoryMb: 256, cpus: 0.25, diskMb: 512 });
  });

  it.each([{ memoryMb: 'lots' }, { memoryMb: -5 }, { memoryMb: 10 }, { cpus: 0 }, { cpus: NaN }, { diskMb: 1.5 }, { memoryMb: 1e12 }])('rejects malformed limit %j', async (body) => {
    db.seedProject('p1', 'alice');
    const res = await request(app).patch('/api/projects/p1').set('Authorization', bearer('alice')).send(body);
    expect(res.status).toBe(400);
  });

  it('lets a user choose LOWER limits', async () => {
    db.seedProject('p1', 'alice');
    const res = await request(app).patch('/api/projects/p1').set('Authorization', bearer('alice')).send({ memoryMb: 128 });
    expect(res.status).toBe(200);
    expect(res.body.limits.effective.memoryMb).toBe(128);
  });

  it('flags a running app whose container predates the current limits as needing a redeploy', async () => {
    db.seedRunning('p1', 'alice');
    db.tables.project[0].memoryMb = 512; // an old project, created before demo mode
    Object.assign(db.tables.deployment[0], { appliedMemoryMb: 512, appliedCpus: 0.5, appliedDiskMb: 1024 });
    const res = await request(app).get('/api/projects/p1').set('Authorization', bearer('alice'));
    expect(res.body.limits.effective.memoryMb).toBe(256); // clamped even though the row says 512
    expect(res.body.limits.applied.memoryMb).toBe(512);
    expect(res.body.limits.needsRedeploy).toBe(true);
  });

  it('reports no redeploy needed once the container matches', async () => {
    db.seedRunning('p1', 'alice');
    Object.assign(db.tables.deployment[0], { appliedMemoryMb: 256, appliedCpus: 0.25, appliedDiskMb: 512 });
    const res = await request(app).get('/api/projects/p1').set('Authorization', bearer('alice'));
    expect(res.body.limits.needsRedeploy).toBe(false);
  });

  it('never advertises disk enforcement unless the worker proved it', async () => {
    const res = await request(app).get('/api/projects/limits').set('Authorization', bearer('alice'));
    expect(res.body.diskQuotaEnforced).toBe(false);
    expect(res.body.demo).toMatchObject({ enabled: true, maxActiveApps: 2, maxDeploysPerHour: 5, deployTimeoutSeconds: 300 });
  });
});

describe('effectiveLimits (what the container really gets)', () => {
  const max = { memoryMb: 256, cpus: 0.25, diskMb: 512 };
  const def = max;
  it('clamps a user to the maximum even if the stored row is higher', () => {
    expect(effectiveLimits({ memoryMb: 4096, cpus: 8, diskMb: 99999 }, 'USER', max, def)).toEqual(max);
  });
  it('replaces garbage with the defaults', () => {
    expect(effectiveLimits({ memoryMb: NaN, cpus: -1, diskMb: 0 }, 'USER', max, def)).toEqual(def);
  });
  it('lets admins exceed the maximum', () => {
    expect(effectiveLimits({ memoryMb: 1024, cpus: 1, diskMb: 2048 }, 'ADMIN', max, def)).toEqual({ memoryMb: 1024, cpus: 1, diskMb: 2048 });
  });
  it('honours a raised administrator maximum', () => {
    expect(effectiveLimits({ memoryMb: 400, cpus: 0.5, diskMb: 512 }, 'USER', { ...max, memoryMb: 512, cpus: 0.5 }, def)).toEqual({ memoryMb: 400, cpus: 0.5, diskMb: 512 });
  });
  it('assertSafeLimits refuses nonsense right before docker run', () => {
    expect(() => assertSafeLimits({ memoryMb: 256, cpus: 0.25, diskMb: 512 })).not.toThrow();
    for (const bad of [{ memoryMb: 0, cpus: 1, diskMb: 512 }, { memoryMb: 256, cpus: NaN, diskMb: 512 }, { memoryMb: 256.5, cpus: 1, diskMb: 512 }]) {
      expect(() => assertSafeLimits(bad)).toThrow(/unsafe resource limits/);
    }
  });
  it('turns the demo limits into docker flags', () => {
    const a = runLimitArgs({ memoryMb: 256, cpus: 0.25, diskMb: 512 }, policy);
    expect(after(a, '--memory')).toBe('256m');
    expect(after(a, '--memory-swap')).toBe('256m');
    expect(after(a, '--cpus')).toBe('0.25');
    expect(a).not.toContain('--storage-opt'); // no genuine quota -> flag is not passed, and not claimed
    expect(after(runLimitArgs({ memoryMb: 256, cpus: 0.25, diskMb: 512 }, { ...policy, storageQuota: true }), '--storage-opt')).toBe('size=512m');
  });
});

describe('assertSafeRunArgs (no privileged flags, host mounts or Docker socket)', () => {
  const ctx = { network: 'devflow_apps', envFile: '/tmp/x.env' };
  const good = () => ['run', '-d', '--name', 'devflow-p-1', '--restart', 'unless-stopped', '--network', 'devflow_apps', '--env-file', '/tmp/x.env',
    ...runLimitArgs({ memoryMb: 256, cpus: 0.25, diskMb: 512 }, { ...policy, storageQuota: true }), '--label', 'devflow.project=abc-1', 'devflow/abc-1:123-45'];
  it('accepts exactly what the worker builds', () => expect(() => assertSafeRunArgs(good(), ctx)).not.toThrow());
  const insert = (...extra: string[]) => { const g = good(); g.splice(1, 0, ...extra); return g; };
  it.each([
    ['--privileged'], ['-v', '/var/run/docker.sock:/var/run/docker.sock'], ['--volume', '/:/host'], ['--mount', 'type=bind,src=/,dst=/h'],
    ['--network', 'host'], ['--pid', 'host'], ['--ipc', 'host'], ['--userns', 'host'], ['--device', '/dev/sda'], ['--cap-add', 'SYS_ADMIN'],
    ['--security-opt', 'seccomp=unconfined'], ['--user', 'root'], ['--add-host', 'x:1.1.1.1'], ['-p', '80:80'], ['--env', 'A=B'],
  ])('rejects %s', (...extra) => expect(() => assertSafeRunArgs(insert(...extra), ctx)).toThrow(/Unsafe docker run/));
  it('rejects a different network, env file or a non-DevFlow image', () => {
    expect(() => assertSafeRunArgs(good().map((a) => (a === 'devflow_apps' ? 'bridge' : a)), ctx)).toThrow();
    expect(() => assertSafeRunArgs(good().map((a) => (a === '/tmp/x.env' ? '/etc/shadow' : a)), ctx)).toThrow();
    const g = good(); g[g.length - 1] = 'alpine:latest';
    expect(() => assertSafeRunArgs(g, ctx)).toThrow(/DevFlow-built image/);
  });
  it('rejects the Docker socket anywhere in the arguments', () => {
    const g = good(); g.splice(g.length - 1, 0, '--label', 'devflow.x=/var/run/docker.sock');
    expect(() => assertSafeRunArgs(g, ctx)).toThrow();
  });
});
