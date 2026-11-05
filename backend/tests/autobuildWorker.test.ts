process.env.NODE_ENV = 'test';
process.env.DEMO_MODE = 'true';

import { cp, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';

jest.mock('../src/db', () => ({ prisma: require('./helpers/db').db }));
jest.mock('../src/redis', () => ({ createRedis: () => ({}), getRedis: () => require('./helpers/db').redis }));
jest.mock('../src/lib/events', () => ({ publishLog: jest.fn(async () => undefined), publishStatus: jest.fn(async () => undefined) }));
jest.mock('../src/lib/caddy', () => ({ syncCaddy: jest.fn(async () => undefined), syncCaddyOnStart: jest.fn(async () => undefined) }));
jest.mock('../src/lib/reaper', () => ({ reapStaleDeployments: jest.fn(async () => []), sweepWorkDir: jest.fn(async () => []) }));
jest.mock('../src/lib/health', () => ({ httpProbe: jest.fn(), waitHealthy: jest.fn(async () => ({ ok: true, attempts: 2 })) }));
jest.mock('bullmq', () => ({ Worker: class { on() {} }, Queue: class {} }));
jest.mock('child_process', () => {
  const execFile: any = jest.fn();
  execFile[require('util').promisify.custom] = async (cmd: string, args: string[]) => ({
    stdout: cmd === 'git' ? 'abcdef1234567890\n' : args[0] === 'image' ? JSON.stringify({ Size: 1024, Config: { Volumes: null } }) : args[0] === 'inspect' ? 'true' : '',
  });
  return { execFile };
});
jest.mock('../src/lib/runProcess', () => ({ runProcess: jest.fn() }));
jest.mock('dns/promises', () => ({ lookup: jest.fn(async () => [{ address: '172.20.0.2' }]) }));

import { config } from '../src/config';
import { db, redisValues } from './helpers/db';
import { runProcess } from '../src/lib/runProcess';
import { processDeployment } from '../src/worker';
import { httpProbe, waitHealthy } from '../src/lib/health';

let tmp: string, fixtureName: string, builtDockerfile: string, originalDockerfile: string | null;
beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'df-worker-auto-'));
  config.workDir = tmp; config.buildSandbox = 'buildkit'; config.drainMs = 0;
  for (const table of Object.keys(db.tables)) db.tables[table] = [];
  redisValues.clear(); jest.clearAllMocks();
  db.seedUser('owner'); db.seedProject('project', 'owner'); db.seedDeployment('deployment', 'project', 'QUEUED');
  fixtureName = 'express'; builtDockerfile = ''; originalDockerfile = null;
  (runProcess as jest.Mock).mockImplementation(async (opts) => {
    if (opts.cmd === 'git') await cp(path.join(__dirname, 'fixtures/autobuild', fixtureName), opts.args[opts.args.length - 1], { recursive: true });
    if (opts.cmd === 'buildctl' && opts.args.includes('build')) {
      const directory = opts.args.find((a: string) => a.startsWith('dockerfile=')).slice('dockerfile='.length);
      builtDockerfile = await readFile(path.join(directory, 'Dockerfile'), 'utf8');
      originalDockerfile = await readFile(path.join(tmp, 'deployment/Dockerfile'), 'utf8').catch(() => null);
    }
    return { outcome: 'ok', code: 0, pid: 123 };
  });
});
afterEach(async () => { await rm(tmp, { recursive: true, force: true }); });
const result = () => db.tables.deployment.find((d) => d.id === 'deployment')!;
const logs = () => db.tables.deploymentLog.map((l) => l.line).join('\n');

it('deploys a generated build through the same sandbox, health check and resource caps', async () => {
  await processDeployment('deployment');
  expect(result()).toMatchObject({ status: 'SUCCESS', buildRule: 'auto-detect', detectedStack: 'Express' });
  expect(builtDockerfile).toContain('USER node'); expect(originalDockerfile).toBeNull();
  const run = (runProcess as jest.Mock).mock.calls.map(([o]) => o).find((o) => o.cmd === 'docker' && o.args[0] === 'run');
  expect(run.args).toEqual(expect.arrayContaining(['--memory', '256m', '--cpus', '0.25', '--security-opt', 'no-new-privileges']));
  expect(logs()).toContain('Generated .devflow/Dockerfile');
});
it('fails undetectable repositories before building, with the new actionable error', async () => {
  fixtureName = 'unknown'; await processDeployment('deployment');
  expect(result()).toMatchObject({ status: 'FAILED', buildRule: 'auto-detect' });
  expect(result().error).toMatch(/Could not auto-detect.*Pick a preset/);
  expect(builtDockerfile).toBe('');
});
it('sends only the selected frontend context to the sandbox, without its sibling backend', async () => {
  fixtureName = 'fullstack'; Object.assign(db.tables.project[0], { rootDir: 'frontend' });
  await processDeployment('deployment');
  expect(result()).toMatchObject({ status: 'SUCCESS', detectedStack: 'Vite' });
  const build = (runProcess as jest.Mock).mock.calls.map(([o]) => o).find(o => o.cmd === 'buildctl' && o.args.includes('build'));
  expect(build.args).toContain(`context=${path.join(tmp, 'deployment/frontend')}`);
  expect(build.args).toContain(`dockerfile=${path.join(tmp, 'deployment/frontend/.devflow')}`);
  expect(builtDockerfile).not.toContain('WORKDIR /app/backend');
});
it('stops changed reviewed plans before running BuildKit or switching the current version', async () => {
  Object.assign(db.tables.project[0], { currentDeploymentId: 'old' });
  Object.assign(db.tables.deployment[0], { preflight: { reviewedPlanId: '0'.repeat(64) } });
  await processDeployment('deployment');
  expect(result()).toMatchObject({ status: 'FAILED', failureClass: 'preflight' });
  expect(result().error).toContain('changed after plan review');
  expect(db.tables.project[0].currentDeploymentId).toBe('old');
  expect((runProcess as jest.Mock).mock.calls.some(([o]) => o.cmd === 'buildctl')).toBe(false);
});
it('uses the reviewed custom health path with strict readiness status checks', async () => {
  Object.assign(db.tables.project[0], { healthPath: '/ready' });
  await processDeployment('deployment');
  expect(result().status).toBe('SUCCESS');
  const health = (waitHealthy as jest.Mock).mock.calls[0][0];
  await health.probe();
  expect(httpProbe).toHaveBeenCalledWith(expect.any(String), 3000, '/ready');
  expect(health.acceptStatus(200)).toBe(true); expect(health.acceptStatus(404)).toBe(false);
});
it('preserves the target readiness settings when reusing a rollback image', async () => {
  Object.assign(db.tables.project[0], { healthPath: '/changed' });
  Object.assign(db.tables.deployment[0], { rollbackOfId: 'old', imageTag: 'devflow/project:old', preflight: { rollbackHealthPath: '/ready', rollbackHealthMode: 'readiness' } });
  await processDeployment('deployment');
  expect(result()).toMatchObject({ status: 'SUCCESS', preflight: { rollbackHealthPath: '/ready', rollbackHealthMode: 'readiness' } });
  const health = (waitHealthy as jest.Mock).mock.calls[0][0];
  await health.probe();
  expect(httpProbe).toHaveBeenCalledWith(expect.any(String), 3000, '/ready');
  expect(health.acceptStatus(404)).toBe(false);
  expect(builtDockerfile).toBe('');
});
it('honors the preset override and leaves the repository Dockerfile unchanged', async () => {
  fixtureName = 'dockerfile'; Object.assign(db.tables.project[0], { preset: 'STATIC', buildMode: 'DOCKERFILE' });
  await processDeployment('deployment');
  expect(result()).toMatchObject({ status: 'SUCCESS', buildRule: 'preset', detectedStack: 'Static site' });
  expect(builtDockerfile).toContain('nginxinc/nginx-unprivileged');
  expect(originalDockerfile).toBe(await readFile(path.join(__dirname, 'fixtures/autobuild/dockerfile/Dockerfile'), 'utf8'));
  expect(logs()).toContain('ignoring that Dockerfile');
});
it('uses a repository Dockerfile unchanged ahead of detection', async () => {
  fixtureName = 'dockerfile'; await processDeployment('deployment');
  expect(result()).toMatchObject({ status: 'SUCCESS', buildRule: 'repo Dockerfile', detectedStack: 'Dockerfile' });
  expect(builtDockerfile).toBe(originalDockerfile);
  expect(logs()).not.toContain('Generated .devflow/Dockerfile');
});
it('refuses generation in explicit DOCKERFILE mode', async () => {
  Object.assign(db.tables.project[0], { buildMode: 'DOCKERFILE' });
  await processDeployment('deployment');
  expect(result().status).toBe('FAILED'); expect(result().error).toContain('No Dockerfile found at the repository root');
  expect(builtDockerfile).toBe('');
});

it('runs release and seed before starting the serving container', async () => {
  Object.assign(db.tables.project[0], { releaseCommand: 'echo migrate', seedCommand: 'echo seed' });
  await processDeployment('deployment');
  expect(result().status).toBe('SUCCESS');
  const commands = (runProcess as jest.Mock).mock.calls.map(([o]) => o).filter((o) => o.cmd === 'docker' && o.args[0] === 'run');
  expect(commands.slice(0, 2).map((o) => o.args.at(-1))).toEqual(['echo migrate', 'echo seed']);
  expect(commands[2].args).toContain('-d');
  expect(commands[0].timeoutMs).toBeLessThanOrEqual(config.deployTimeoutMs);
});
it('executes reviewed repository release commands in constrained one-off containers', async () => {
  const original = (runProcess as jest.Mock).getMockImplementation()!;
  (runProcess as jest.Mock).mockImplementation(async opts => {
    const result = await original(opts);
    if (opts.cmd === 'git') await writeFile(path.join(opts.args.at(-1), 'devflow.json'), JSON.stringify({ version: 1, releaseCommand: 'echo repo-migrate', seedCommand: 'echo repo-seed' }));
    return result;
  });
  await processDeployment('deployment');
  expect(result().status).toBe('SUCCESS');
  const commands = (runProcess as jest.Mock).mock.calls.map(([o]) => o).filter(o => o.cmd === 'docker' && o.args.includes('--entrypoint'));
  expect(commands.map(o => o.args.at(-1))).toEqual(['echo repo-migrate', 'echo repo-seed']);
  expect(commands[0].args).toEqual(expect.arrayContaining(['--memory', '256m', '--security-opt', 'no-new-privileges']));
});

it.each(['failed', 'timeout'])('keeps the old version serving when release returns %s', async outcome => {
  Object.assign(db.tables.project[0], { releaseCommand: 'echo migrate', currentDeploymentId: 'old' });
  db.seedDeployment('old', 'project', 'SUCCESS', { createdAt: new Date(0) });
  const original = (runProcess as jest.Mock).getMockImplementation()!;
  (runProcess as jest.Mock).mockImplementation(async opts => opts.cmd === 'docker' && opts.args.includes('--entrypoint') ? { outcome, code: 1, pid: 123 } : original(opts));
  await processDeployment('deployment');
  expect(result()).toMatchObject({ status: 'FAILED', failureClass: outcome === 'timeout' ? 'timeout' : 'release' });
  expect(db.tables.project[0].currentDeploymentId).toBe('old');
  expect((runProcess as jest.Mock).mock.calls.some(([o]) => o.cmd === 'docker' && o.args[0] === 'run' && o.args.includes('-d'))).toBe(false);
});
