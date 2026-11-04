import { mkdtemp, mkdir, writeFile, rm, symlink } from 'fs/promises';
import os from 'os';
import path from 'path';
import { preflight, preflightKey } from '../src/lib/autobuild/preflight';
import { supportMatrix } from '../src/lib/autobuild/support';
import { detect } from '../src/lib/autobuild';
import { render } from '../src/lib/autobuild/render';
import { buildReliability } from '../src/lib/reliability';
let tmp: string;
beforeEach(async () => { tmp = await mkdtemp(path.join(os.tmpdir(), 'df-preflight-')); });
afterEach(async () => { await rm(tmp, { recursive: true, force: true }); });
async function put(name: string, text: string) { await mkdir(path.dirname(path.join(tmp, name)), { recursive: true }); await writeFile(path.join(tmp, name), text); }
const nodeApp = async (source: string) => { await put('package.json', JSON.stringify({ scripts: { start: 'node server.js' } })); await put('server.js', source); };

it('catches Pocket fixed-port and loopback failures before a build', async () => {
  await nodeApp('require("http").createServer().listen(4173, "127.0.0.1");');
  const result = await preflight(tmp, { containerPort: 3000 }, []);
  expect(result.status).toBe('unsupported');
  expect(result.findings).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'network.fixed-port', severity: 'blocker', action: { type: 'set-port', port: 4173 }, evidence: [{ file: 'server.js', line: 1 }] }), expect.objectContaining({ id: 'network.loopback', severity: 'blocker' })]));
});
it('accepts environment-driven listening and never executes code or uses the network', async () => {
  await nodeApp('throw new Error("MUST NOT EXECUTE"); server.listen(process.env.PORT, process.env.HOST);');
  const network = jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network forbidden'));
  const execution = jest.spyOn(require('child_process'), 'spawn').mockImplementation(() => { throw new Error('execution forbidden'); });
  try { expect((await preflight(tmp, {}, [])).status).toBe('supported'); expect(network).not.toHaveBeenCalled(); expect(execution).not.toHaveBeenCalled(); }
  finally { network.mockRestore(); execution.mockRestore(); }
});
it('lets the one-click port fix resolve a reachable fixed-port listener', async () => {
  await nodeApp('server.listen(4173,"0.0.0.0");');
  expect((await preflight(tmp, { containerPort: 3000 }, [])).status).toBe('unsupported');
  expect((await preflight(tmp, { containerPort: 4173 }, [])).status).toBe('supported-with-warnings');
});
it('returns only environment names, never default/example/real .env values', async () => {
  await nodeApp('server.listen(process.env.PORT); const key=process.env.API_KEY || "DO_NOT_LEAK";');
  await put('.env.example', 'EXAMPLE_TOKEN=actual-secret-value\n'); await put('.env', 'PRIVATE_KEY=DO_NOT_LEAK\n');
  const result = await preflight(tmp, {}, []);
  expect(result.requiredEnv).toEqual(['API_KEY', 'EXAMPLE_TOKEN']);
  expect(JSON.stringify(result)).not.toMatch(/DO_NOT_LEAK|actual-secret-value|PRIVATE_KEY/);
  expect((await preflight(tmp, {}, ['API_KEY', 'EXAMPLE_TOKEN'])).requiredEnv).toEqual([]);
});
it('blocks strict missing Python configuration and warns about external services', async () => {
  await put('requirements.txt', 'flask\nredis\nstripe\n');
  await put('app.py', 'import os\nfrom flask import Flask\napp = Flask(__name__)\nsecret = os.environ["APP_SECRET"]\n');
  const result = await preflight(tmp, {}, []);
  expect(result.findings).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'env.missing.APP_SECRET', severity: 'blocker' }), expect.objectContaining({ id: 'service.redis', severity: 'warning' }), expect.objectContaining({ id: 'service.payments', severity: 'warning' })]));
});
it('rejects compose multi-service, native and GPU workloads', async () => {
  await nodeApp('server.listen(process.env.PORT);');
  await put('docker-compose.yml', 'services:\n  web:\n    image: web\n  db:\n    image: postgres\n');
  await put('requirements.txt', 'tensorflow\n'); await mkdir(path.join(tmp, 'android'));
  const result = await preflight(tmp, {}, []);
  expect(result.findings.map(f => f.id)).toEqual(expect.arrayContaining(['layout.compose', 'layout.native', 'layout.ml']));
  expect(result.status).toBe('unsupported');
});
it('reports an unsafe scan rather than following a repository symlink', async () => {
  await symlink('/etc/passwd', path.join(tmp, 'Dockerfile'));
  const result = await preflight(tmp, {}, []);
  expect(result).toMatchObject({ status: 'unsupported', findings: [expect.objectContaining({ id: 'inspection.unsafe' })] });
});
it('defines stateless SQLite/release semantics and allows external DB setup', async () => {
  await nodeApp('server.listen(process.env.PORT); const db="sqlite3";');
  expect((await preflight(tmp, { releaseCommand: 'migrate' }, [])).findings.map(f => f.id)).toContain('storage.release-local');
  expect((await preflight(tmp, { releaseCommand: 'migrate' }, ['DATABASE_URL'])).findings.map(f => f.id)).not.toContain('storage.release-local');
});
it('invalidates checks when settings, commands or configured variable names change', () => {
  const base = { repoUrl: 'https://github.com/o/r', branch: 'main' };
  expect(preflightKey(base, ['B','A'])).toBe(preflightKey(base, ['A','B']));
  for (const changed of [{ branch: 'next' }, { releaseCommand: 'migrate' }, { seedCommand: 'seed' }, { containerPort: 4173 }, { preset: 'STATIC' as const }]) expect(preflightKey({ ...base, ...changed }, [])).not.toBe(preflightKey(base, []));
});
it('renders CA, Django settings/static files and trusted proxy wrappers', async () => {
  const fixtures = path.join(__dirname, 'fixtures/autobuild');
  const ctx = { port: 3000, limits: { memoryMb: 256, cpus: 0.25, diskMb: 512 } };
  const django = render(await detect(path.join(fixtures, 'django')), ctx);
  for (const token of ['ca-certificates', 'DJANGO_ALLOWED_HOSTS', 'DJANGO_CSRF_TRUSTED_ORIGINS', 'collectstatic', 'WhiteNoise', 'forwarded-allow-ips']) expect(django).toContain(token);
  const flask = render(await detect(path.join(fixtures, 'flask')), ctx); expect(flask).toContain('ProxyFix'); expect(flask).toContain('REMOTE_ADDR');
  const fastapi = render(await detect(path.join(fixtures, 'fastapi')), ctx); expect(fastapi).toContain('proxy_headers=True');
  expect(supportMatrix.stacks.map(s => s.id)).toEqual(['static', 'node', 'python', 'fullstack', 'dockerfile']);
});
it('reports first-attempt reliability without counting retries as first successes', () => {
  const row = { detectedStack: 'Node', preflight: { status: 'supported' }, failureClass: null, createdAt: new Date(0) };
  const result = buildReliability([{ ...row, projectId: 'a', status: 'FAILED', failureClass: 'health' }, { ...row, projectId: 'a', status: 'SUCCESS', createdAt: new Date(1) }, { ...row, projectId: 'b', status: 'SUCCESS' }]);
  expect(result[0]).toMatchObject({ firstAttempts: 2, firstSuccesses: 1, firstAttemptSuccessRate: 0.5, failed: 1, success: 2 });
});
