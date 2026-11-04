import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from 'fs/promises';
import path from 'path';
import os from 'os';
import { analyzeDeployment } from '../src/lib/autobuild/analyze';
import { prepareBuild } from '../src/lib/autobuild';
import { repositoryRevision } from '../src/lib/autobuild/plan';
const fixtures = path.join(__dirname, 'fixtures/autobuild');
const ctx = { port: 3000, healthPath: '/', limits: { memoryMb: 256, cpus: 0.25, diskMb: 512 } };
let tmp: string;
beforeEach(async () => { tmp = await mkdtemp(path.join(os.tmpdir(), 'df-plan-')); });
afterEach(async () => { await rm(tmp, { recursive: true, force: true }); });
it('materializes the same recipe that was reviewed, with explicit frontend-only scope', async () => {
  await cp(path.join(fixtures, 'fullstack'), tmp, { recursive: true });
  const analysis = await analyzeDeployment(tmp, { rootDir: 'frontend' }, [], ctx, 102400, 'a'.repeat(40));
  expect(analysis.report.plan).toMatchObject({ version: 1, revision: 'a'.repeat(40), root: 'frontend', scope: 'static-assets', port: 3000, limits: ctx.limits });
  expect(analysis.report.plan!.components).toHaveLength(1);
  const build = await prepareBuild(tmp, { rootDir: 'frontend' }, ctx, 102400, async () => undefined, undefined, analysis.resolved);
  expect(await readFile(path.join(build.dockerfileDir, 'Dockerfile'), 'utf8')).toBe(analysis.resolved!.text);
  expect(build.contextDir).toBe(path.join(tmp, 'frontend'));
});
it('changes identity for revisions, effective policy, environment names and commands', async () => {
  await cp(path.join(fixtures, 'express'), tmp, { recursive: true });
  const run = (settings = {}, env: string[] = [], context = ctx, revision = 'a'.repeat(40)) => analyzeDeployment(tmp, settings, env, context, 102400, revision);
  const original = (await run()).report.plan!.id;
  expect((await run()).report.plan!.id).toBe(original);
  for (const result of [await run({}, [], ctx, 'b'.repeat(40)), await run({}, ['API_KEY']), await run({ startCommand: 'node other.js' }), await run({}, [], { ...ctx, limits: { ...ctx.limits, memoryMb: 128 } })]) expect(result.report.plan!.id).not.toBe(original);
});
it('describes internal backend ports without claiming application workflow verification', async () => {
  await cp(path.join(fixtures, 'fullstack'), tmp, { recursive: true });
  const { report } = await analyzeDeployment(tmp, {}, [], { ...ctx, port: 4000 }, 102400);
  expect(report.plan).toMatchObject({ scope: 'cohosted-frontend-api', port: 4000 });
  expect(report.plan!.components.map(c => c.port)).toEqual([4000, 4001]);
  expect(report.plan!.verification).toContain('application workflows and external credentials are unverified');
});
it('reads bounded Git metadata and never needs to execute repository code', async () => {
  await mkdir(path.join(tmp, '.git/refs/heads'), { recursive: true });
  await writeFile(path.join(tmp, '.git/HEAD'), 'ref: refs/heads/main\n');
  await writeFile(path.join(tmp, '.git/refs/heads/main'), 'a'.repeat(40));
  expect(await repositoryRevision(tmp)).toBe('a'.repeat(40));
  await writeFile(path.join(tmp, '.git/HEAD'), 'ref: refs/../../outside');
  expect(await repositoryRevision(tmp)).toBeNull();
});
it('does not expose Dockerfile contents or real env files in the public plan', async () => {
  await cp(path.join(fixtures, 'dockerfile'), tmp, { recursive: true });
  await writeFile(path.join(tmp, '.env'), 'SECRET_VALUE=DO_NOT_LEAK');
  const { report } = await analyzeDeployment(tmp, {}, [], ctx, 102400);
  expect(report.plan).toMatchObject({ scope: 'dockerfile', components: [] });
  expect(JSON.stringify(report)).not.toContain('DO_NOT_LEAK');
});
