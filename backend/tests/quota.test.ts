process.env.NODE_ENV = 'test';
process.env.DEMO_MODE = 'true';
process.env.DEPLOY_BURST_PER_MIN = '1000'; // the coarse per-minute limiter is process-wide; the hourly rule is what these tests exercise

import crypto from 'crypto';
import request from 'supertest';

jest.mock('../src/db', () => ({ prisma: require('./helpers/db').db }));
jest.mock('../src/queue', () => ({ getQueue: () => require('./helpers/db').queue }));
jest.mock('../src/redis', () => ({ getRedis: () => require('./helpers/db').redis, createRedis: () => require('./helpers/db').redis }));

import { createApp } from '../src/app';
import { config } from '../src/config';
import { signToken } from '../src/middleware/auth';
import { db, queue, redis, redisValues } from './helpers/db';

const app = createApp();
const bearer = (id: string, role: 'USER' | 'ADMIN' = 'USER') => `Bearer ${signToken({ id, role })}`;
const deploy = (user: string, project: string, role: 'USER' | 'ADMIN' = 'USER') =>
  request(app).post(`/api/projects/${project}/deploy`).set('Authorization', bearer(user, role));

beforeEach(() => {
  for (const t of Object.keys(db.tables)) db.tables[t] = [];
  db.ignoreLocks = false;
  db.txDelayMs = 5;
  redisValues.clear();
  jest.clearAllMocks();
  db.seedUser('alice');
  db.seedUser('bob');
});

describe('demo defaults', () => {
  it('is configured for the public demo', () => {
    expect(config.demo.enabled).toBe(true);
    expect(config.demo.maxActiveApps).toBe(2);
    expect(config.demo.maxDeploysPerHour).toBe(5);
    expect(config.deployTimeoutMs).toBe(5 * 60 * 1000);
    expect(config.defaultLimits).toEqual({ memoryMb: 256, cpus: 0.25, diskMb: 512 });
    expect(config.maxLimits).toEqual({ memoryMb: 256, cpus: 0.25, diskMb: 512 });
  });
});

describe('active application quota', () => {
  beforeEach(() => {
    db.seedRunning('a1', 'alice');
    db.seedRunning('a2', 'alice');
    db.seedProject('a3', 'alice');
  });

  it('rejects a third active application with a clear error', async () => {
    const res = await deploy('alice', 'a3');
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('ACTIVE_APP_QUOTA_REACHED');
    expect(res.body.error).toMatch(/2 of 2 active deployments/);
    expect(res.body.error).toMatch(/Delete one of your deployed apps/);
    expect(db.tables.deployment.filter((d) => d.projectId === 'a3')).toHaveLength(0); // nothing was queued
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('allows redeploying an application that already holds a slot', async () => {
    const res = await deploy('alice', 'a1');
    expect(res.status).toBe(202);
    expect(res.body.status).toBe('QUEUED');
    expect(queue.add).toHaveBeenCalledWith('deploy', { deploymentId: res.body.id }, expect.anything());
  });

  it('allows rolling back an application that already holds a slot', async () => {
    db.tables.deployment.find((d) => d.id === 'a1-live')!.imageTag = 'devflow/a1:abc';
    const res = await request(app).post('/api/deployments/a1-live/rollback').set('Authorization', bearer('alice'));
    expect(res.status).toBe(202);
  });

  it('frees a slot when an application is deleted', async () => {
    expect((await request(app).delete('/api/projects/a1').set('Authorization', bearer('alice'))).status).toBe(204);
    expect((await deploy('alice', 'a3')).status).toBe(202);
  });

  it.each(['QUEUED', 'BUILDING', 'DEPLOYING'])('counts an app whose first deployment is %s as active', async (status) => {
    db.tables.deployment = db.tables.deployment.filter((d) => d.projectId !== 'a2');
    db.tables.project.find((p) => p.id === 'a2')!.currentDeploymentId = null; // a2 is no longer running ...
    db.seedDeployment('a2-first', 'a2', status); // ... but its first version is on its way
    const res = await deploy('alice', 'a3');
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('ACTIVE_APP_QUOTA_REACHED');
  });

  it('does not count apps that only have failed or cancelled deployments', async () => {
    db.tables.project.find((p) => p.id === 'a2')!.currentDeploymentId = null;
    db.tables.deployment = db.tables.deployment.filter((d) => d.projectId !== 'a2');
    db.seedDeployment('a2-bad', 'a2', 'FAILED');
    db.seedDeployment('a2-stop', 'a2', 'CANCELLED');
    expect((await deploy('alice', 'a3')).status).toBe(202);
  });

  it('ignores in-flight rows left behind by a lost worker', async () => {
    db.tables.project.find((p) => p.id === 'a2')!.currentDeploymentId = null;
    db.tables.deployment = db.tables.deployment.filter((d) => d.projectId !== 'a2');
    db.seedDeployment('a2-dead', 'a2', 'BUILDING', { createdAt: new Date(Date.now() - config.demo.staleAfterMs - 60_000) });
    expect((await deploy('alice', 'a3')).status).toBe(202);
  });

  it('does not limit administrators', async () => {
    db.seedUser('root', 'ADMIN');
    ['r1', 'r2', 'r3'].forEach((id) => db.seedRunning(id, 'root'));
    db.seedProject('r4', 'root');
    expect((await deploy('root', 'r4', 'ADMIN')).status).toBe(202);
  });
});

describe('one build at a time', () => {
  it('rejects a second deployment while one is queued or running', async () => {
    db.seedProject('p1', 'alice');
    db.seedProject('p2', 'alice');
    expect((await deploy('alice', 'p1')).status).toBe(202);
    const again = await deploy('alice', 'p1');
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('BUILD_IN_PROGRESS');
    expect((await deploy('alice', 'p2')).body.code).toBe('BUILD_IN_PROGRESS');
  });

  it('does not block other users', async () => {
    db.seedProject('p1', 'alice');
    db.seedProject('p2', 'bob');
    expect((await deploy('alice', 'p1')).status).toBe(202);
    expect((await deploy('bob', 'p2')).status).toBe(202);
  });

  it('refuses to delete a project while it is building (that would hide the build from the rule)', async () => {
    db.seedProject('p1', 'alice');
    await deploy('alice', 'p1');
    const res = await request(app).delete('/api/projects/p1').set('Authorization', bearer('alice'));
    expect(res.status).toBe(409);
    expect(db.tables.project).toHaveLength(1);
  });

  it('fails the row (instead of leaving it QUEUED) when the queue is down', async () => {
    db.seedProject('p1', 'alice');
    queue.add.mockRejectedValueOnce(new Error('redis down'));
    jest.spyOn(console, 'error').mockImplementationOnce(() => undefined);
    const res = await deploy('alice', 'p1');
    expect(res.status).toBe(503);
    expect(db.tables.deployment[0].status).toBe('FAILED');
    expect((await deploy('alice', 'p1')).status).toBe(202); // not stuck behind the dead row
  });
});

describe('concurrent deployment attempts', () => {
  // Control experiment: with the row lock disabled the very same scenario DOES exceed the limit,
  // so the passing tests below are evidence that the lock is what holds the line.
  const racers = async () => {
    db.seedRunning('a1', 'alice'); // 1 of 2 slots used
    db.seedProject('n1', 'alice');
    db.seedProject('n2', 'alice');
    db.seedProject('n3', 'alice');
    return Promise.all(['n1', 'n2', 'n3'].map((p) => deploy('alice', p)));
  };

  it('control: without the per-user lock the race is real', async () => {
    db.ignoreLocks = true;
    const results = await racers();
    expect(results.filter((r) => r.status === 202).length).toBeGreaterThan(1); // quota (and one-build rule) broken
  });

  it('with the lock, only one of three simultaneous new apps is accepted', async () => {
    const results = await racers();
    expect(results.filter((r) => r.status === 202)).toHaveLength(1);
    expect(results.filter((r) => r.status !== 202).every((r) => ['ACTIVE_APP_QUOTA_REACHED', 'BUILD_IN_PROGRESS'].includes(r.body.code))).toBe(true);
    expect(db.tables.deployment.filter((d) => d.status === 'QUEUED')).toHaveLength(1);
    expect(db.lockCalls).toBeGreaterThanOrEqual(3);
  });

  it('with the lock, ten simultaneous deploys of one app start exactly one build', async () => {
    db.seedRunning('a1', 'alice');
    const results = await Promise.all(Array.from({ length: 10 }, () => deploy('alice', 'a1')));
    expect(results.filter((r) => r.status === 202)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(9);
    expect(db.tables.deploymentAttempt).toHaveLength(1);
  });

  it('with the lock, two users racing do not affect each other', async () => {
    db.seedProject('p1', 'alice');
    db.seedProject('p2', 'bob');
    const [a, b] = await Promise.all([deploy('alice', 'p1'), deploy('bob', 'p2')]);
    expect([a.status, b.status]).toEqual([202, 202]);
  });
});

describe('deployment attempts per hour', () => {
  const attemptsAgo = (n: number, minutes: number) => {
    for (let i = 0; i < n; i++) db.tables.deploymentAttempt.push({ id: `old-${minutes}-${i}`, userId: 'alice', createdAt: new Date(Date.now() - minutes * 60_000) });
  };

  it('accepts 5 attempts and rejects the 6th with 429 + Retry-After', async () => {
    db.seedRunning('a1', 'alice');
    for (let i = 1; i <= 5; i++) {
      const ok = await deploy('alice', 'a1');
      expect(ok.status).toBe(202);
      db.tables.deployment.find((d) => d.id === ok.body.id)!.status = 'FAILED'; // finished, so the next one is not "in progress"
    }
    const res = await deploy('alice', 'a1');
    expect(res.status).toBe(429);
    expect(res.body.code).toBe('DEPLOY_RATE_LIMITED');
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
    expect(res.body.attempts).toBe(5);
    expect(res.body.maxAttempts).toBe(5);
    // failed attempts count: the limit is on attempts, not on successes
  });

  it('is a rolling window: attempts older than an hour stop counting', async () => {
    db.seedProject('p1', 'alice');
    attemptsAgo(5, 61);
    expect((await deploy('alice', 'p1')).status).toBe(202);
  });

  it('tells the user when the oldest attempt leaves the window', async () => {
    db.seedProject('p1', 'alice');
    attemptsAgo(3, 50);
    attemptsAgo(1, 30);
    const res = await deploy('alice', 'p1');
    expect(res.status).toBe(202);
    db.tables.deployment[0].status = 'SUCCESS';
    const blocked = await deploy('alice', 'p1');
    expect(blocked.status).toBe(429);
    expect(blocked.body.retryAfterSeconds).toBeGreaterThan(9 * 60);
    expect(blocked.body.retryAfterSeconds).toBeLessThanOrEqual(10 * 60);
  });

  it('cannot be reset by deleting and recreating the project', async () => {
    db.seedProject('p1', 'alice');
    attemptsAgo(5, 5);
    expect((await deploy('alice', 'p1')).status).toBe(429);
    await request(app).delete('/api/projects/p1').set('Authorization', bearer('alice'));
    const created = await request(app).post('/api/projects').set('Authorization', bearer('alice'))
      .send({ name: 'fresh', repoUrl: 'https://github.com/o/r' });
    expect(created.status).toBe(201);
    expect((await deploy('alice', created.body.id)).status).toBe(429);
  });

  it('counts rollbacks too', async () => {
    db.seedRunning('a1', 'alice');
    db.tables.deployment.find((d) => d.id === 'a1-live')!.imageTag = 'devflow/a1:abc';
    attemptsAgo(5, 1);
    const res = await request(app).post('/api/deployments/a1-live/rollback').set('Authorization', bearer('alice'));
    expect(res.status).toBe(429);
  });

  it('applies to GitHub push webhooks, charged to the project owner', async () => {
    db.seedProject('p1', 'alice', { webhookSecret: 'whsec' });
    attemptsAgo(5, 1);
    const body = JSON.stringify({ ref: 'refs/heads/main' });
    const res = await request(app).post('/api/webhooks/github/p1').set('Content-Type', 'application/json')
      .set('X-GitHub-Event', 'push')
      .set('X-Hub-Signature-256', 'sha256=' + crypto.createHmac('sha256', 'whsec').update(body).digest('hex'))
      .send(body);
    expect(res.status).toBe(429);
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('does not charge the user for system redeploys started by an admin', async () => {
    db.seedUser('root', 'ADMIN');
    db.seedRunning('a1', 'alice'); // limits unknown -> counts as out of policy
    db.tables.deployment.find((d) => d.id === 'a1-live')!.imageTag = 'devflow/a1:abc';
    const res = await request(app).post('/api/admin/redeploy-out-of-policy').set('Authorization', bearer('root', 'ADMIN'));
    expect(res.status).toBe(202);
    expect(res.body.queued).toHaveLength(1);
    expect(db.tables.deploymentAttempt).toHaveLength(0);
    expect(db.tables.deployment.find((d) => d.id === res.body.queued[0].deploymentId)!.triggeredById).toBeNull();
  });
});

describe('project cap and previews', () => {
  it('limits the number of projects per account', async () => {
    for (let i = 0; i < config.demo.maxProjects; i++) db.seedProject(`p${i}`, 'alice');
    const res = await request(app).post('/api/projects').set('Authorization', bearer('alice')).send({ name: 'one more', repoUrl: 'https://github.com/o/r' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('PROJECT_LIMIT_REACHED');
    const other = await request(app).post('/api/projects').set('Authorization', bearer('bob')).send({ name: 'mine', repoUrl: 'https://github.com/o/r' });
    expect(other.status).toBe(201);
  });

  it('keeps pull-request previews off for ordinary users (each one is another running container)', async () => {
    db.seedProject('p1', 'alice');
    const res = await request(app).patch('/api/projects/p1').set('Authorization', bearer('alice')).send({ previewsEnabled: true });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('PREVIEWS_DISABLED');
  });

  it('caps environment variables per project', async () => {
    db.seedProject('p1', 'alice');
    for (let i = 0; i < config.demo.maxEnvVars; i++) db.tables.envVar.push({ id: `e${i}`, projectId: 'p1', key: `K${i}`, valueEnc: 'x' });
    const res = await request(app).put('/api/projects/p1/env').set('Authorization', bearer('alice')).send({ key: 'ONE_MORE', value: 'v' });
    expect(res.status).toBe(403);
    const update = await request(app).put('/api/projects/p1/env').set('Authorization', bearer('alice')).send({ key: 'K1', value: 'v' });
    expect(update.status).toBe(200); // replacing an existing key is fine
  });
});

describe('usage endpoint (what the dashboard shows)', () => {
  it('keeps attempts, active applications and failures apart', async () => {
    db.seedRunning('a1', 'alice');
    db.seedProject('p2', 'alice');
    db.seedDeployment('f1', 'p2', 'FAILED');
    db.seedDeployment('f2', 'p2', 'FAILED');
    db.tables.deploymentAttempt.push({ id: 'x1', userId: 'alice', createdAt: new Date() }, { id: 'x2', userId: 'alice', createdAt: new Date() }, { id: 'x3', userId: 'alice', createdAt: new Date() });
    const res = await request(app).get('/api/projects/usage').set('Authorization', bearer('alice'));
    expect(res.status).toBe(200);
    expect(res.body.activeApps).toMatchObject({ used: 1, max: 2 });
    expect(res.body.deployAttempts).toMatchObject({ used: 3, max: 5, windowMinutes: 60 });
    expect(res.body.failedDeployments.last24h).toBe(2);
    expect(res.body.projects).toMatchObject({ used: 2, max: 5 });
    expect(res.body.build.timeoutSeconds).toBe(300);
  });

  it('only reports the caller\'s own usage', async () => {
    db.seedRunning('b1', 'bob');
    const res = await request(app).get('/api/projects/usage').set('Authorization', bearer('alice'));
    expect(res.body.activeApps.used).toBe(0);
  });
});

describe('ownership isolation', () => {
  beforeEach(() => {
    db.seedRunning('a1', 'alice');
    db.tables.deployment.find((d) => d.id === 'a1-live')!.imageTag = 'devflow/a1:abc';
    db.tables.deploymentLog.push({ id: 1, deploymentId: 'a1-live', line: 'hello', createdAt: new Date() });
  });
  const asBob = (m: 'get' | 'post' | 'patch' | 'put' | 'delete', url: string) => (request(app) as any)[m](url).set('Authorization', bearer('bob'));

  it.each([
    ['get', '/api/projects/a1'],
    ['patch', '/api/projects/a1'],
    ['delete', '/api/projects/a1'],
    ['post', '/api/projects/a1/deploy'],
    ['get', '/api/projects/a1/deployments'],
    ['get', '/api/projects/a1/env'],
    ['put', '/api/projects/a1/env'],
    ['delete', '/api/projects/a1/env/KEY'],
    ['put', '/api/projects/a1/github-token'],
    ['get', '/api/projects/a1/previews'],
    ['get', '/api/deployments/a1-live'],
    ['get', '/api/deployments/a1-live/logs'],
    ['post', '/api/deployments/a1-live/rollback'],
    ['post', '/api/deployments/a1-live/cancel'],
  ] as const)('another user gets 404 on %s %s', async (method, url) => {
    const res = await asBob(method, url).send({ key: 'K', value: 'v', token: 'x'.repeat(30), memoryMb: 128 });
    expect(res.status).toBe(404);
    expect(db.tables.project).toHaveLength(1); // nothing deleted
    expect(db.tables.deployment).toHaveLength(1); // nothing queued
    expect(db.tables.project[0].memoryMb).toBe(256); // nothing modified
  });

  it('requires a token on every sensitive route', async () => {
    for (const [m, u] of [['get', '/api/projects/a1'], ['post', '/api/projects/a1/deploy'], ['get', '/api/projects/usage'], ['post', '/api/deployments/a1-live/cancel'], ['post', '/api/admin/redeploy-out-of-policy']] as const) {
      expect((await (request(app) as any)[m](u)).status).toBe(401);
    }
  });

  it('keeps ordinary users out of admin routes', async () => {
    expect((await asBob('post', '/api/admin/redeploy-out-of-policy')).status).toBe(403);
    expect((await asBob('get', '/api/admin/users')).status).toBe(403);
  });

  it('never returns stored secrets', async () => {
    db.tables.project[0].githubTokenEnc = 'enc:secret-token';
    db.tables.envVar.push({ id: 'e1', projectId: 'a1', key: 'DB_PASSWORD', valueEnc: 'enc:hunter2' });
    const project = await request(app).get('/api/projects/a1').set('Authorization', bearer('alice'));
    const env = await request(app).get('/api/projects/a1/env').set('Authorization', bearer('alice'));
    const all = JSON.stringify([project.body, env.body]);
    expect(all).not.toContain('secret-token');
    expect(all).not.toContain('hunter2');
    expect(all).not.toContain('githubTokenEnc');
    expect(all).not.toContain('valueEnc');
    expect(project.body.hasGithubToken).toBe(true);
  });
});

describe('admin user deletion', () => {
  it('queues container teardown for every project of a deleted user', async () => {
    db.seedUser('root', 'ADMIN');
    db.seedRunning('a1', 'alice');
    db.seedRunning('a2', 'alice');
    db.tables.user = db.tables.user.filter(Boolean);
    (db as any).user.delete = async ({ where }: any) => { db.tables.user = db.tables.user.filter((u) => u.id !== where.id); };
    const res = await request(app).delete('/api/admin/users/alice').set('Authorization', bearer('root', 'ADMIN'));
    expect(res.status).toBe(204);
    expect(queue.add.mock.calls.filter((c: any[]) => c[0] === 'teardown').map((c: any[]) => (c[1] as any).projectId).sort()).toEqual(['a1', 'a2']);
  });
});
