process.env.NODE_ENV = 'test';
process.env.DEMO_MODE = 'true';

import { existsSync } from 'fs';
import { mkdtemp, mkdir, readFile, rm, symlink, utimes, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';

jest.mock('../src/db', () => ({ prisma: require('./helpers/db').db }));
import { config } from '../src/config';
import { classifyFailure, cleanupDeployment, DeployCancelled, DeployTimeout } from '../src/lib/deployCleanup';
import { lintDockerfile, lintDockerfileAt } from '../src/lib/dockerfileLint';
import { checkImage } from '../src/lib/imagePolicy';
import { createLogGate, redact } from '../src/lib/logGate';
import { reapStaleDeployments, sweepWorkDir } from '../src/lib/reaper';
import { runProcess } from '../src/lib/runProcess';
import { db } from './helpers/db';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// A killed process that nobody has reaped yet is a zombie: dead, but still listed. Count it as dead.
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return require('fs').readFileSync(`/proc/${pid}/stat`, 'utf8').split(' ')[2] !== 'Z';
  } catch {
    return false;
  }
};
let tmp: string;
beforeEach(async () => { tmp = await mkdtemp(path.join(os.tmpdir(), 'df-jobs-')); });
afterEach(async () => { await rm(tmp, { recursive: true, force: true }); });

// A "build" that starts a helper in the background, like git-remote-https or a package manager's workers do.
const buildWithHelper = async () => {
  const pidFile = path.join(tmp, 'helper.pid');
  const args = ['-c', `sleep 60 & echo $! > "${pidFile}"; wait`];
  return { args, helperPid: async () => { await sleep(150); return Number(await readFile(pidFile, 'utf8')); } };
};

describe('runProcess: timeout, cancel and size cap kill the whole process group', () => {
  it('times out and kills the helper processes too', async () => {
    const b = await buildWithHelper();
    const started = Date.now();
    const res = await runProcess({ cmd: 'sh', args: b.args, timeoutMs: 500 });
    expect(res.outcome).toBe('timeout');
    expect(Date.now() - started).toBeLessThan(5000);
    const helper = await b.helperPid();
    await sleep(100);
    expect(alive(helper)).toBe(false);
  });

  it('cancels on request and kills the helper processes too', async () => {
    const b = await buildWithHelper();
    let flag = false;
    setTimeout(() => (flag = true), 400);
    const res = await runProcess({ cmd: 'sh', args: b.args, timeoutMs: 20_000, isCancelled: async () => flag, cancelPollMs: 100 });
    expect(res.outcome).toBe('cancelled');
    const helper = await b.helperPid();
    await sleep(100);
    expect(alive(helper)).toBe(false);
  });

  it('stops a command that writes a file past the size cap', async () => {
    const out = path.join(tmp, 'image.tar');
    const res = await runProcess({
      cmd: 'sh', args: ['-c', `dd if=/dev/zero of="${out}" bs=1k count=200000 2>/dev/null`],
      timeoutMs: 20_000, watchFile: { path: out, maxBytes: 1024 * 1024 }, watchPollMs: 50,
    });
    expect(res.outcome).toBe('too-large');
  });

  it('reports success, failure and streams output', async () => {
    const chunks: string[] = [];
    expect((await runProcess({ cmd: 'sh', args: ['-c', 'echo hi'], timeoutMs: 5000, onOutput: (c) => chunks.push(c) })).outcome).toBe('ok');
    expect(chunks.join('')).toContain('hi');
    const bad = await runProcess({ cmd: 'sh', args: ['-c', 'exit 3'], timeoutMs: 5000 });
    expect(bad).toMatchObject({ outcome: 'failed', code: 3 });
  });
});

describe('cleanup after failed, timed-out and cancelled jobs', () => {
  // The same sequence the worker runs: do some work in temp files, fail in a given way, then clean up.
  const files = async () => {
    const workDir = path.join(tmp, 'dep1');
    const envFile = path.join(tmp, 'dep1.env');
    const imageTar = path.join(tmp, 'dep1.image.tar');
    await mkdir(path.join(workDir, 'src'), { recursive: true });
    await writeFile(path.join(workDir, 'src', 'a.js'), 'x');
    await writeFile(envFile, 'SECRET=hunter2\n', { mode: 0o600 });
    await writeFile(imageTar, Buffer.alloc(1024));
    return [workDir, envFile, imageTar];
  };
  const makeIO = () => {
    const removed: string[] = [];
    let cancelFlag = true;
    return { removed, cancelFlagCleared: () => !cancelFlag, io: {
      removeContainer: async (n: string) => void removed.push(n),
      removePath: (p: string) => rm(p, { recursive: true, force: true }),
      clearCancelFlag: async () => void (cancelFlag = false),
    } };
  };

  it.each([
    ['failed', new Error('boom')],
    ['timeout', new DeployTimeout('too slow')],
    ['cancelled', new DeployCancelled('Cancelled')],
  ] as const)('a %s job leaves no temp files, secrets, container or cancel flag', async (expected, err) => {
    const paths = await files();
    expect(classifyFailure(err)).toBe(expected);
    const h = makeIO();
    const problems = await cleanupDeployment({ candidateContainer: 'devflow-p-1', switched: false, paths, failed: true }, h.io);
    expect(problems).toEqual([]);
    paths.forEach((p) => expect(existsSync(p)).toBe(false));
    expect(h.removed).toEqual(['devflow-p-1']);
    expect(h.cancelFlagCleared()).toBe(true);
  });

  it('a timed-out real process is dead and its temp files are gone', async () => {
    const paths = await files();
    const b = await buildWithHelper();
    const res = await runProcess({ cmd: 'sh', args: b.args, cwd: paths[0], timeoutMs: 400 });
    expect(res.outcome).toBe('timeout');
    await cleanupDeployment({ candidateContainer: null, switched: false, paths, failed: true }, makeIO().io);
    paths.forEach((p) => expect(existsSync(p)).toBe(false));
    expect(alive(await b.helperPid())).toBe(false);
  });

  it('keeps the container once traffic was switched to it (success), still removes temp files', async () => {
    const paths = await files();
    const h = makeIO();
    await cleanupDeployment({ candidateContainer: 'devflow-p-1', switched: true, paths, failed: false }, h.io);
    expect(h.removed).toEqual([]);
    paths.forEach((p) => expect(existsSync(p)).toBe(false));
  });

  it('keeps cleaning when one step fails and reports it', async () => {
    const paths = await files();
    const h = makeIO();
    const problems = await cleanupDeployment({ candidateContainer: 'c', switched: false, paths, failed: true }, { ...h.io, removeContainer: async () => { throw new Error('docker hung'); } });
    expect(problems[0]).toMatch(/docker hung/);
    paths.forEach((p) => expect(existsSync(p)).toBe(false));
    expect(h.cancelFlagCleared()).toBe(true);
  });
});

describe('reaper (lost workers)', () => {
  beforeEach(() => { for (const t of Object.keys(db.tables)) db.tables[t] = []; });
  const old = (ms: number) => new Date(Date.now() - ms);

  it('fails deployments stuck past the deadline and removes their container, leaves healthy ones alone', async () => {
    const stuck = config.deployTimeoutMs + 5 * 60_000;
    db.seedProject('p1', 'u');
    db.seedDeployment('stuck', 'p1', 'BUILDING', { startedAt: old(stuck) });
    db.seedDeployment('stuck2', 'p1', 'DEPLOYING', { startedAt: old(stuck) });
    db.seedDeployment('lostq', 'p1', 'QUEUED', { createdAt: old(config.demo.staleAfterMs + 60_000) });
    db.seedDeployment('fresh', 'p1', 'BUILDING', { startedAt: old(30_000) });
    db.seedDeployment('freshq', 'p1', 'QUEUED');
    db.seedDeployment('done', 'p1', 'SUCCESS', { startedAt: old(stuck) });
    const removed: string[] = [];
    const ids = await reapStaleDeployments({ removeContainer: async (n) => void removed.push(n) });
    expect(ids.sort()).toEqual(['lostq', 'stuck', 'stuck2']);
    const status = (id: string) => db.tables.deployment.find((d) => d.id === id)!.status;
    expect(['stuck', 'stuck2', 'lostq'].map(status)).toEqual(['FAILED', 'FAILED', 'FAILED']);
    expect(['fresh', 'freshq', 'done'].map(status)).toEqual(['BUILDING', 'QUEUED', 'SUCCESS']);
    expect(removed).toHaveLength(3);
  });

  it('sweeps old leftovers from the work dir but not recent builds', async () => {
    await mkdir(path.join(tmp, 'old-build'));
    await writeFile(path.join(tmp, 'old.env'), 'S=1');
    await mkdir(path.join(tmp, 'recent-build'));
    const ancient = new Date(Date.now() - 6 * 3600_000);
    await utimes(path.join(tmp, 'old-build'), ancient, ancient);
    await utimes(path.join(tmp, 'old.env'), ancient, ancient);
    expect((await sweepWorkDir(tmp)).sort()).toEqual(['old-build', 'old.env']);
    expect(existsSync(path.join(tmp, 'recent-build'))).toBe(true);
  });
});

describe('log output limits and secret masking', () => {
  const gate = (o = {}) => createLogGate({ maxLines: 5, maxBytes: 10_000, maxLineChars: 50, ...o });
  it('drops output after the line cap and says so once', () => {
    const g = gate();
    const out = [...g('a\nb\nc'), ...g('d\ne\nf\ng'), ...g('h')];
    expect(out.slice(0, 5)).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(out).toHaveLength(6);
    expect(out[5]).toMatch(/Log output limit reached/);
  });
  it('caps total bytes', () => {
    const g = gate({ maxLines: 1000, maxBytes: 100, maxLineChars: 60 });
    const total = Array.from({ length: 50 }, () => g('x'.repeat(40))).flat();
    expect(total.join('').length).toBeLessThan(400);
    expect(total.some((l) => /limit reached/.test(l))).toBe(true);
  });
  it('truncates very long lines', () => {
    expect(gate()('y'.repeat(500))[0].length).toBeLessThan(80);
  });
  it('masks env values, GitHub tokens, AWS keys and URL credentials', () => {
    const secrets = ['hunter2-long-value'];
    expect(redact('db password is hunter2-long-value ok', secrets)).toBe('db password is *** ok');
    expect(redact('token ghp_abcdefghijklmnopqrstuvwxyz0123456789 end')).toBe('token *** end');
    expect(redact('github_pat_11ABCDEFG0123456789_abcdefghijklmnop')).toBe('***');
    expect(redact('key AKIAIOSFODNN7EXAMPLE here')).toBe('key *** here');
    expect(redact('git clone https://user:pa55w0rd@github.com/o/r')).toBe('git clone https://***@github.com/o/r');
    expect(redact('short', ['abc'])).toBe('short'); // too short to be a secret: do not mangle ordinary text
  });
  it('applies masking through the gate', () => {
    expect(gate({ secrets: () => ['s3cr3t-value'] })('leak s3cr3t-value now')).toEqual(['leak *** now']);
  });
});

describe('Dockerfile lint', () => {
  const o = { maxBytes: 100 * 1024 };
  it('accepts an ordinary Dockerfile, including the official syntax directive', () => {
    expect(lintDockerfile('# syntax=docker/dockerfile:1\nFROM node:20\nRUN npm ci\n', o)).toEqual([]);
    expect(lintDockerfile('# syntax = docker/dockerfile:1.7\nFROM node:20', o)).toEqual([]);
  });
  it('rejects custom frontends, insecure/host entitlements and oversized files', () => {
    expect(lintDockerfile('# syntax=evil/frontend:latest\nFROM x', o)[0]).toMatch(/custom Dockerfile frontend/);
    expect(lintDockerfile('FROM x\nRUN --security=insecure make', o)[0]).toMatch(/insecure/);
    expect(lintDockerfile('FROM x\nRUN --network=host curl x', o)[0]).toMatch(/network=host/);
    expect(lintDockerfile('FROM x\n' + '#'.repeat(2000), { maxBytes: 100 })[0]).toMatch(/larger than/);
  });
  it('refuses a missing or symlinked Dockerfile', async () => {
    expect((await lintDockerfileAt(tmp, o))[0]).toMatch(/No Dockerfile/);
    await writeFile(path.join(tmp, 'real'), 'FROM x');
    await symlink('/etc/passwd', path.join(tmp, 'Dockerfile'));
    expect((await lintDockerfileAt(tmp, o))[0]).toMatch(/regular file/);
    await rm(path.join(tmp, 'Dockerfile'));
    await writeFile(path.join(tmp, 'Dockerfile'), 'FROM node:20');
    expect(await lintDockerfileAt(tmp, o)).toEqual([]);
  });
});

describe('built image policy', () => {
  const img = (size: number, volumes: object | null = null) => JSON.stringify({ Size: size, Config: { Volumes: volumes } });
  const mb = 1024 * 1024;
  it('rejects oversized images', () => expect(checkImage(img(2000 * mb), { maxImageMb: 1024, rejectVolumes: true })).toMatch(/2000 MB.*1024 MB/));
  it('rejects image-declared VOLUMEs when demo rules are on (they bypass disk limits)', () => {
    expect(checkImage(img(10 * mb, { '/data': {} }), { maxImageMb: 1024, rejectVolumes: true })).toMatch(/VOLUME \/data/);
    expect(checkImage(img(10 * mb, { '/data': {} }), { maxImageMb: 1024, rejectVolumes: false })).toBeNull();
  });
  it('accepts a normal image and refuses unreadable metadata', () => {
    expect(checkImage(img(200 * mb), { maxImageMb: 1024, rejectVolumes: true })).toBeNull();
    expect(checkImage('not json', { maxImageMb: 1024, rejectVolumes: true })).toMatch(/Could not read/);
  });
});
