import { mkdtemp, mkdir, writeFile, rm, symlink, readFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { configuredSettings } from '../src/lib/autobuild/configuration';
import { analyzeDeployment } from '../src/lib/autobuild/analyze';
import { prepareBuild } from '../src/lib/autobuild';
let tmp: string;
const ctx = { port: 3000, limits: { memoryMb: 256, cpus: 0.25, diskMb: 512 } };
beforeEach(async () => { tmp = await mkdtemp(path.join(os.tmpdir(), 'df-repo-config-')); });
afterEach(async () => { await rm(tmp, { recursive: true, force: true }); });
async function put(name: string, text: string) { await mkdir(path.dirname(path.join(tmp, name)), { recursive: true }); await writeFile(path.join(tmp, name), text); }
const config = (value: unknown) => put('devflow.json', JSON.stringify(value));
it('uses repository defaults and records explicit dashboard overrides without changing resources', async () => {
  await config({ version: 1, rootDir: 'frontend', startCommand: 'node app.js', releaseCommand: 'echo migrate' });
  const resolved = await configuredSettings(tmp, { rootDir: '.', startCommand: null });
  expect(resolved.settings).toMatchObject({ rootDir: '.', startCommand: 'node app.js', releaseCommand: 'echo migrate' });
  expect(resolved.source).toEqual({ file: 'devflow.json', version: 1, dashboardOverrides: ['rootDir'] });
});
it.each([{ version: 2 }, { version: 1, env: { SECRET: 'DO_NOT_LEAK' } }, { version: 1, memoryMb: 4096 }, { version: 1, network: 'host' }, { version: 1, rootDir: '../outside' }, { version: 1, entrypoint: 'app:app;whoami' }, { version: 1, startCommand: 'node app.js\nFROM evil' }])('blocks invalid configuration without exposing its values: %j', async value => {
  await config(value);
  const { report } = await analyzeDeployment(tmp, {}, [], ctx, 102400);
  expect(report).toMatchObject({ status: 'unsupported', findings: [expect.objectContaining({ id: 'config.invalid' })] });
  expect(JSON.stringify(report)).not.toContain('DO_NOT_LEAK');
});
it('refuses symlink configuration and permits explicit dashboard-only mode', async () => {
  await symlink('/etc/passwd', path.join(tmp, 'devflow.json'));
  await expect(configuredSettings(tmp, {})).rejects.toThrow();
  expect((await configuredSettings(tmp, { useRepositoryConfig: false })).source).toBeNull();
});
it('refuses malformed and oversized config without parser snippets', async () => {
  for (const value of ['{"secret":"DO_NOT_LEAK",', ' '.repeat(17000)]) {
    await put('devflow.json', value);
    const { report } = await analyzeDeployment(tmp, {}, [], ctx, 102400);
    expect(report.findings[0].id).toBe('config.invalid'); expect(JSON.stringify(report)).not.toContain('DO_NOT_LEAK');
  }
});
it('resolves a repository root and materializes the exact configured build', async () => {
  await config({ version: 1, rootDir: 'web' }); await put('web/index.html', '<h1>Configured app</h1>');
  const analysis = await analyzeDeployment(tmp, {}, [], ctx, 102400);
  expect(analysis.report).toMatchObject({ status: 'supported', plan: { root: 'web', scope: 'static-assets', configuration: { version: 1 } } });
  const plan = await prepareBuild(tmp, {}, ctx, 102400, async () => undefined, undefined, analysis.resolved);
  expect(plan.contextDir).toBe(path.join(tmp, 'web'));
  expect(await readFile(path.join(plan.dockerfileDir, 'Dockerfile'), 'utf8')).toBe(analysis.resolved!.text);
});
it('offers real Python entry points and deploys only the selected one without execution', async () => {
  await put('requirements.txt', 'flask');
  await put('first.py', 'from flask import Flask\napp = Flask(__name__)\nraise RuntimeError("NEVER EXECUTE")');
  await put('second.py', 'from flask import Flask\napi = Flask(__name__)');
  const ambiguous = await analyzeDeployment(tmp, {}, [], ctx, 102400);
  expect(ambiguous.report.status).toBe('unsupported');
  expect(ambiguous.report.choices?.map(c => c.entrypoint)).toEqual(['first:app', 'second:api']);
  await config({ version: 1, entrypoint: 'second:api' });
  const chosen = await analyzeDeployment(tmp, {}, [], ctx, 102400);
  expect(chosen.report).toMatchObject({ status: 'supported', plan: { stack: 'Flask' } });
  expect(chosen.resolved!.text).toContain('DEVFLOW_PYTHON_TARGET=second:api');
  expect((await analyzeDeployment(tmp, { entrypoint: 'missing:app' }, [], ctx, 102400)).report.status).toBe('unsupported');
});
it('offers bounded directory choices with explicit frontend-only consequences', async () => {
  await put('client/index.html', 'client'); await put('web/index.html', 'web');
  const { report } = await analyzeDeployment(tmp, {}, [], ctx, 102400);
  expect(report.choices?.map(c => c.rootDir)).toEqual(['client', 'web']);
  expect(report.choices?.every(c => c.scope.includes('Frontend only'))).toBe(true);
});
it('lets an explicit Dockerfile selection override repository presets', async () => {
  await config({ version: 1, preset: 'PYTHON_FLASK', entrypoint: 'app:app' });
  expect((await configuredSettings(tmp, { buildMode: 'DOCKERFILE' })).settings).toMatchObject({ buildMode: 'DOCKERFILE', preset: null, entrypoint: null });
});
it('does not advertise a function-local Flask object as a module-level HTTP entry point', async () => {
  await put('requirements.txt', 'flask');
  await put('app.py', 'from flask import Flask\ndef create_app():\n    app = Flask(__name__)\n    return app\n');
  const { report } = await analyzeDeployment(tmp, {}, [], ctx, 102400);
  expect(report.status).toBe('unsupported'); expect(report.plan).toBeUndefined();
  expect(report.choices).toEqual([]);
});
it('offers multiple top-level Python objects from one module, including annotated objects', async () => {
  await put('requirements.txt', 'fastapi');
  await put('main.py', 'from fastapi import FastAPI\nfirst: FastAPI = FastAPI()\nsecond = FastAPI()');
  const { report } = await analyzeDeployment(tmp, {}, [], ctx, 102400);
  expect(report.choices?.map(c => c.entrypoint)).toEqual(['main:first', 'main:second']);
});
it('resolves health paths from config and permits a dashboard override', async () => {
  await config({ version: 1, healthPath: '/ready' }); await put('index.html', 'site');
  expect((await analyzeDeployment(tmp, {}, [], ctx, 102400)).report.plan?.healthPath).toBe('/ready');
  expect((await analyzeDeployment(tmp, {}, [], ctx, 102400)).report.plan?.healthMode).toBe('readiness');
  expect((await analyzeDeployment(tmp, { healthPath: '/healthz' }, [], ctx, 102400)).report.plan?.healthPath).toBe('/healthz');
});
