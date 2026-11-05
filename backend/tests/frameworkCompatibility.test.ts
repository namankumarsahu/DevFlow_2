import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises';
import path from 'path';
import os from 'os';
import { analyzeDeployment } from '../src/lib/autobuild/analyze';
import { detect } from '../src/lib/autobuild';
import { nodeBuild, nodeStart, render } from '../src/lib/autobuild/render';
let tmp: string;
const ctx = { port: 3000, limits: { memoryMb: 256, cpus: 0.25, diskMb: 512 } };
beforeEach(async () => { tmp = await mkdtemp(path.join(os.tmpdir(), 'df-framework-')); });
afterEach(async () => { await rm(tmp, { recursive: true, force: true }); });
async function put(name: string, text: string) { await mkdir(path.dirname(path.join(tmp, name)), { recursive: true }); await writeFile(path.join(tmp, name), text); }
const pkg = (value: unknown) => put('package.json', JSON.stringify(value));
it('prefers the declared production script for NestJS instead of compiling with nest start at runtime', async () => {
  await pkg({ dependencies: { '@nestjs/core': '^10.3.0' }, scripts: { build: 'nest build', start: 'nest start', 'start:prod': 'node dist/main.js' } });
  const { report, resolved } = await analyzeDeployment(tmp, {}, [], ctx, 102400);
  expect(report.plan).toMatchObject({ stack: 'NestJS', components: [expect.objectContaining({ start: 'npm run start:prod' })] });
  expect(resolved!.text).toContain('npm run start:prod');
});
it('supports a production script without an ordinary start script and respects an explicit override', async () => {
  await pkg({ scripts: { 'start:prod': 'node server.js' } });
  const detection = await detect(tmp); if (detection.parameters.kind !== 'node') throw Error('Expected Node');
  expect(detection.parameters.hasStart).toBe(true);
  expect(nodeStart(detection.parameters)).toBe('npm run start:prod');
  expect(nodeStart(detection.parameters, 'node custom.js')).toBe('node custom.js');
});
it('builds Next.js without requiring package scripts and keeps its production binding', async () => {
  await pkg({ dependencies: { next: '^15.5.9', react: '^19.0.0', 'react-dom': '^19.0.0' } });
  const detection = await detect(tmp); if (detection.parameters.kind !== 'node') throw Error('Expected Node');
  expect(nodeBuild(detection.parameters)).toBe('./node_modules/.bin/next build');
  expect(nodeStart(detection.parameters)).toContain('next start --hostname 0.0.0.0 --port');
  expect(render(detection, ctx)).toContain('./node_modules/.bin/next build');
});
it('blocks workspace installs before a build and suggests independent child applications', async () => {
  await pkg({ workspaces: ['apps/*'], scripts: { start: 'node server.js' } });
  await put('server.js', 'server.listen(process.env.PORT);');
  await put('apps/web/index.html', '<h1>Independent web app</h1>');
  const { report } = await analyzeDeployment(tmp, {}, [], ctx, 102400);
  expect(report.findings).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'layout.workspace', severity: 'blocker' })]));
  expect(report.choices?.map(choice => choice.rootDir)).toEqual(['apps/web']);
});
it('blocks workspace protocol dependencies even when the selected folder has no workspaces field', async () => {
  await pkg({ dependencies: { shared: 'workspace:*' }, scripts: { start: 'node server.js' } });
  expect((await analyzeDeployment(tmp, {}, [], ctx, 102400)).report.status).toBe('unsupported');
});
it('ignores unused dev/build/dependency mentions when warning about the actual startup bind', async () => {
  await pkg({ scripts: { start: 'node server.js', dev: 'vite', build: 'echo uvicorn' }, devDependencies: { tool: 'vite' } });
  await put('server.js', 'server.listen(process.env.PORT);');
  expect((await analyzeDeployment(tmp, {}, [], ctx, 102400)).report.findings.map(f => f.id)).not.toContain('network.default-host');
  expect((await analyzeDeployment(tmp, { startCommand: 'uvicorn main:app' }, [], ctx, 102400)).report.findings.map(f => f.id)).toContain('network.default-host');
});
it('warns about frontend build variables even when a same-named runtime variable exists', async () => {
  await pkg({ dependencies: { vite: '^5.0.0' }, scripts: { build: 'vite build' } });
  await put('src/main.js', 'const base=import.meta.env.VITE_API_URL; const mode=import.meta.env.MODE;');
  const missing = (await analyzeDeployment(tmp, {}, [], ctx, 102400)).report;
  expect(missing.requiredEnv).toEqual(['VITE_API_URL']);
  expect(missing.findings.find(f => f.id === 'env.missing.VITE_API_URL')?.action).toBeUndefined();
  expect((await analyzeDeployment(tmp, {}, ['VITE_API_URL'], ctx, 102400)).report.findings.map(f => f.id)).toContain('env.frontend-build');
});
