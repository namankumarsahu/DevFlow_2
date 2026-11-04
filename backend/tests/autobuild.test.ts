import { cp, mkdtemp, readFile, readdir, rm, mkdir, symlink, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { detect, detectPreset, generatedExclusions, prepareBuild } from '../src/lib/autobuild';
import { render } from '../src/lib/autobuild/render';
import { strategies } from '../src/lib/autobuild/registry';
import { BuildSettings } from '../src/lib/autobuild/types';
import { buildctlArgs } from '../src/lib/buildSandbox';
import { lintDockerfile } from '../src/lib/dockerfileLint';

const fixtures = path.join(__dirname, 'fixtures/autobuild');
const ctx = { port: 3000, limits: { memoryMb: 256, cpus: 0.25, diskMb: 512 } };
let tmp: string;
beforeEach(async () => { tmp = await mkdtemp(path.join(os.tmpdir(), 'df-auto-')); });
afterEach(async () => { await rm(tmp, { recursive: true, force: true }); });
const fixture = (name: string) => path.join(fixtures, name);
const prepare = async (name: string, settings: BuildSettings = {}) => {
  await cp(fixture(name), tmp, { recursive: true });
  const logs: string[] = [];
  const plan = await prepareBuild(tmp, settings, ctx, 100 * 1024, async (line) => { logs.push(line); });
  return { plan, logs };
};

describe('auto-build detection and rendering', () => {
  it('keeps the strategy registry in priority order', () => expect(strategies.map((s) => s.id)).toEqual(['fullstack', 'node', 'python', 'static']));
  it.each([
    ['static', 'static', 'Static site'], ['vite', 'node', 'Vite'], ['express', 'node', 'Express'],
    ['next', 'node', 'Next.js'], ['django', 'python', 'Django'], ['flask', 'python', 'Flask'],
    ['fastapi', 'python', 'FastAPI'], ['fullstack', 'fullstack', 'Frontend + Django'],
  ])('detects %s and produces a linted, unprivileged, runtime-port Dockerfile', async (name, strategyId, stack) => {
    const detection = await detect(fixture(name));
    expect(detection).toMatchObject({ strategyId, stack });
    expect(detection.evidence.length).toBeGreaterThan(0);
    const dockerfile = render(detection, ctx);
    expect(lintDockerfile(dockerfile, { maxBytes: 100 * 1024 })).toEqual([]);
    expect(dockerfile).toContain('$PORT');
    expect(dockerfile.match(/^USER .+$/gm)?.pop()).toMatch(/^USER (101|node)$/);
    expect(dockerfile).not.toMatch(/JWT_SECRET|DATABASE_URL|ENCRYPTION_KEY|devflow-test-fixture-only/);
    expect(dockerfile).not.toContain('0.0.0.0:3000');
    expect(dockerfile).not.toMatch(/FROM (postgres|redis|mysql)/);
  });
  it('does not execute code or touch the network during detection', async () => {
    const fetch = jest.spyOn(globalThis, 'fetch').mockImplementation(async () => { throw new Error('Network forbidden'); });
    const spawn = jest.spyOn(require('child_process'), 'spawn').mockImplementation(() => { throw new Error('Execution forbidden'); });
    try {
      const before = await readdir(fixture('fullstack'));
      await detect(fixture('fullstack'));
      expect(fetch).not.toHaveBeenCalled(); expect(spawn).not.toHaveBeenCalled();
      expect(await readdir(fixture('fullstack'))).toEqual(before);
    } finally { fetch.mockRestore(); spawn.mockRestore(); }
  });
  it('recognizes static output directories', async () => {
    await mkdir(path.join(tmp, 'out')); await writeFile(path.join(tmp, 'out/index.html'), '<h1>out</h1>');
    expect((await detect(tmp)).parameters).toMatchObject({ kind: 'static', output: 'out' });
  });
  it('detects lockfiles, frozen installs, and allowed Node versions', async () => {
    await writeFile(path.join(tmp, 'package.json'), JSON.stringify({ scripts: { start: 'node main.js' }, engines: { node: '^24' } }));
    await writeFile(path.join(tmp, 'pnpm-lock.yaml'), 'lockfileVersion: 9');
    const pnpm = render(await detect(tmp), ctx);
    expect(pnpm).toContain('node:24-alpine'); expect(pnpm).toContain('pnpm install --frozen-lockfile');
    await rm(path.join(tmp, 'pnpm-lock.yaml')); await writeFile(path.join(tmp, 'yarn.lock'), '# yarn lockfile v1');
    expect(render(await detect(tmp), ctx)).toContain('yarn install --frozen-lockfile');
    await rm(path.join(tmp, 'yarn.lock')); await writeFile(path.join(tmp, 'package-lock.json'), '{}');
    expect(render(await detect(tmp), ctx)).toContain('npm ci');
    await writeFile(path.join(tmp, 'package.json'), JSON.stringify({ main: 'main.js', engines: { node: '999' } }));
    expect(render(await detect(tmp), ctx)).toContain('node:22-alpine');
  });
  it('recognizes a standard pyproject manifest without executing it', async () => {
    await writeFile(path.join(tmp, 'pyproject.toml'), '[project]\nname="app"\nversion="1"\ndependencies=["fastapi"]');
    await writeFile(path.join(tmp, 'main.py'), 'from fastapi import FastAPI\napp = FastAPI()');
    expect((await detect(tmp)).parameters).toMatchObject({ manifest: 'pyproject.toml', target: 'main:app' });
    expect(render(await detect(tmp), ctx)).toContain('pip install --no-cache-dir . uvicorn');
  });
  it('supports fixed Python presets and rejects mismatched manifests', async () => {
    expect((await detectPreset(fixture('django'), 'PYTHON_DJANGO')).stack).toBe('Django');
    expect((await detectPreset(fixture('flask'), 'PYTHON_FLASK')).parameters).toMatchObject({ framework: 'flask' });
    expect((await detectPreset(fixture('fastapi'), 'PYTHON_FASTAPI')).parameters).toMatchObject({ framework: 'fastapi' });
    await expect(detectPreset(fixture('static'), 'NODE')).rejects.toThrow(/Preset NODE/);
  });
  it('lets the NODE preset override frontend detection with a server command', async () => {
    const forced = await detectPreset(fixture('vite'), 'NODE');
    expect(forced).toMatchObject({ stack: 'Node', parameters: { framework: 'node' } });
    expect(render(forced, { ...ctx, startCommand: 'node server.js' })).not.toContain('FROM nginxinc/');
  });
  it('rejects ambiguous monorepos and entry points with actionable messages', async () => {
    await cp(fixture('fullstack'), tmp, { recursive: true }); await mkdir(path.join(tmp, 'client'));
    await expect(detect(tmp)).rejects.toThrow(/Ambiguous.*preset/);
  });
  it('never follows repository symlinks or overwrites reserved paths', async () => {
    await symlink(fixture('express'), path.join(tmp, 'backend'));
    await mkdir(path.join(tmp, 'frontend')); await writeFile(path.join(tmp, 'frontend/index.html'), 'static');
    await expect(detect(tmp)).rejects.toThrow(/symlink/);
    await rm(path.join(tmp, 'backend'));
    await writeFile(path.join(tmp, 'index.html'), 'static');
    await symlink(os.tmpdir(), path.join(tmp, '.devflow'));
    await expect(prepareBuild(tmp, {}, ctx, 100 * 1024, async () => undefined)).rejects.toThrow(/symlink/);
  });
});

describe('precedence and generated context isolation', () => {
  it('lets explicit presets override a Dockerfile even in DOCKERFILE mode', async () => {
    const original = await readFile(path.join(fixture('dockerfile'), 'Dockerfile'), 'utf8');
    const { plan, logs } = await prepare('dockerfile', { preset: 'STATIC', buildMode: 'DOCKERFILE' });
    expect(plan).toMatchObject({ rule: 'preset', generated: true, stack: 'Static site' });
    expect(logs.join('\n')).toContain('ignoring that Dockerfile');
    expect(await readFile(path.join(tmp, 'Dockerfile'), 'utf8')).toBe(original);
  });
  it('uses the repo Dockerfile unchanged before auto-detection', async () => {
    const { plan } = await prepare('dockerfile');
    expect(plan).toMatchObject({ generated: false, dockerfileDir: tmp, rule: 'repo Dockerfile' });
    await expect(readFile(path.join(tmp, '.devflow/Dockerfile'))).rejects.toThrow();
  });
  it('keeps the existing missing-Dockerfile error in DOCKERFILE mode', async () => {
    await expect(prepare('static', { buildMode: 'DOCKERFILE' })).rejects.toThrow('No Dockerfile found at the repository root');
  });
  it('fails an undetectable repository with the supported stacks and settings hint', async () => {
    await expect(prepare('unknown')).rejects.toThrow(/Supported stacks:.*Pick a preset/);
  });
  it('writes only .devflow files and enforces exclusions after user ignore rules', async () => {
    await cp(fixture('express'), tmp, { recursive: true });
    await writeFile(path.join(tmp, '.dockerignore'), '!**\n');
    const plan = await prepareBuild(tmp, {}, ctx, 100 * 1024, async () => undefined);
    expect(plan.dockerfileDir).toBe(path.join(tmp, '.devflow'));
    const ignores = await readFile(path.join(plan.dockerfileDir, 'Dockerfile.dockerignore'), 'utf8');
    expect(ignores.endsWith(generatedExclusions)).toBe(true);
    expect(ignores).toMatch(/node_modules/); expect(ignores).toMatch(/\.env/); expect(ignores).toMatch(/tests/);
    const args = buildctlArgs({ addr: 'tcp://buildkit:1234', contextDir: tmp, dockerfileDir: plan.dockerfileDir, imageTag: 'x', tarPath: '/tmp/x.tar' });
    expect(args).toContain(`context=${tmp}`); expect(args).toContain(`dockerfile=${plan.dockerfileDir}`);
    await expect(readFile(path.join(tmp, 'Dockerfile'))).rejects.toThrow();
  });
});

describe('Dockerfile instruction injection protection', () => {
  it.each(['echo ok\nFROM evil', 'echo ok\rRUN evil', 'x\0y', 'x\x1by', 'x\u2028y', 'x\u2029y', 'x'.repeat(1001), '   '])('rejects control characters and invalid command lengths', async (value) => {
    const detection = await detect(fixture('express'));
    expect(() => render(detection, { ...ctx, startCommand: value })).toThrow(/Commands/);
    expect(() => render(detection, { ...ctx, buildCommand: value })).toThrow(/Commands/);
  });
  it('keeps quotes and backslashes inside JSON-array instructions', async () => {
    const startCommand = 'printf "%s" "a\\b"; echo "FROM evil"';
    const buildCommand = 'echo "COPY /etc/passwd /leak" \\';
    const text = render(await detect(fixture('express')), { ...ctx, startCommand, buildCommand });
    for (const line of text.split('\n').filter((s) => /^(RUN|CMD) /.test(s))) {
      expect(() => JSON.parse(line.slice(line.indexOf('[')))).not.toThrow();
    }
    expect(text.split('\n').filter((s) => s.startsWith('FROM '))).toHaveLength(2);
    const command = text.split('\n').find((s) => s.startsWith('CMD '))!;
    expect(JSON.parse(command.slice(4))).toEqual(['sh', '-ec', `export PORT="$PORT"; ${startCommand}`]);
    expect(text).not.toContain('\nFROM evil');
  });
});
