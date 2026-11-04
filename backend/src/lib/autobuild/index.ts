import { lstat, mkdir, writeFile } from 'fs/promises';
import path from 'path';
import { lintDockerfile, lintDockerfileAt } from '../dockerfileLint';
import { detectPython } from './detect';
import { entry, file } from './files';
import { strategies } from './registry';
import { BuildPlan, BuildSettings, Detection, Preset, RenderContext, StrategyId } from './types';

export const supported = 'Supported stacks: static sites, Node (Vite, CRA, Next.js, Express/Nest), Django, Flask, FastAPI, and frontend + backend monorepos. Pick a preset in project settings or add a Dockerfile.';
const presetStrategy: Record<Preset, StrategyId> = { STATIC: 'static', NODE: 'node', PYTHON_DJANGO: 'python', PYTHON_FLASK: 'python', PYTHON_FASTAPI: 'python', FULLSTACK: 'fullstack' };
export async function detect(repoDir: string): Promise<Detection> {
  for (const strategy of strategies) {
    const detection = await strategy.detect(repoDir);
    if (detection) return detection;
  }
  throw new Error(`Could not auto-detect this repository. ${supported}`);
}
export async function detectPreset(repoDir: string, preset: Preset): Promise<Detection> {
  const strategy = strategies.find((s) => s.id === presetStrategy[preset]);
  const framework = preset === 'PYTHON_DJANGO' ? 'django' : preset === 'PYTHON_FLASK' ? 'flask' : preset === 'PYTHON_FASTAPI' ? 'fastapi' : null;
  const detection = framework ? await detectPython(repoDir, '.', framework) : await strategy?.detect(repoDir);
  if (!detection) throw new Error(`Preset ${preset} needs its manifest and entry point in the repository. ${supported}`);
  // NODE is an explicit server preset, so a stray Vite/CRA dependency must not
  // force static hosting after the user has chosen a server start command.
  if (preset === 'NODE' && detection.parameters.kind === 'node') {
    detection.parameters.framework = 'node'; detection.stack = 'Node';
  }
  return detection;
}
// App code remains the build context. This Dockerfile-specific ignore file
// enforces exclusions even when the repository has permissive ! patterns.
export const generatedExclusions = [
  '**/.git', '**/.env', '**/.env.*', '**/node_modules', '**/tests', '**/test', '**/__tests__',
  '**/*.test.*', '**/*.spec.*', '**/test_*.py', '**/*_test.py', '**/.pytest_cache', '**/__pycache__',
  '**/.venv', '**/venv', '**/.cache', '**/.devflow', '**/*.pem', '**/*.key',
].join('\n') + '\n';

export async function prepareBuild(repoDir: string, settings: BuildSettings, ctx: RenderContext, maxBytes: number, log: (line: string) => Promise<void>, record: (meta: { rule: string; stack?: string }) => Promise<void> = async () => undefined): Promise<BuildPlan> {
  let repoDockerfile = false;
  try { await lstat(path.join(repoDir, 'Dockerfile')); repoDockerfile = true; } catch (e: any) { if (e.code !== 'ENOENT') throw e; }
  if (!settings.preset && (repoDockerfile || settings.buildMode === 'DOCKERFILE')) {
    await record({ rule: 'repo Dockerfile', stack: 'Dockerfile' });
    const problems = await lintDockerfileAt(repoDir, { maxBytes });
    if (problems.length) throw new Error(`Dockerfile rejected: ${problems.join('; ')}`);
    await log('==> Build rule: repo Dockerfile (used unchanged)');
    return { rule: 'repo Dockerfile', stack: 'Dockerfile', evidence: ['Dockerfile'], dockerfileDir: repoDir, generated: false };
  }
  const rule = settings.preset ? 'preset' : 'auto-detect';
  await record({ rule });
  await log(`==> Build rule: ${rule}${settings.preset ? ` (${settings.preset})` : ''}`);
  const warning = settings.preset && repoDockerfile ? 'Explicit preset overrides the repository Dockerfile; ignoring that Dockerfile' : undefined;
  if (warning) await log(`==> WARNING: ${warning}`);
  const detection = settings.preset ? await detectPreset(repoDir, settings.preset) : await detect(repoDir);
  await record({ rule, stack: detection.stack });
  const strategy = strategies.find((s) => s.id === detection.strategyId)!;
  const text = strategy.render(detection, { ...ctx, startCommand: settings.startCommand, buildCommand: settings.buildCommand });
  const problems = lintDockerfile(text, { maxBytes });
  if (problems.length) throw new Error(`Generated Dockerfile rejected: ${problems.join('; ')}`);
  const generatedDir = path.join(repoDir, '.devflow');
  if (await entry(repoDir, '.devflow/Dockerfile') || await entry(repoDir, '.devflow/Dockerfile.dockerignore')) throw new Error('Repository uses reserved .devflow/Dockerfile paths; remove them or use a root Dockerfile');
  await mkdir(generatedDir, { recursive: true });
  const originalIgnore = await file(repoDir, '.dockerignore') ?? '';
  await writeFile(path.join(generatedDir, 'Dockerfile'), text, { flag: 'wx' });
  await writeFile(path.join(generatedDir, 'Dockerfile.dockerignore'), originalIgnore + '\n' + generatedExclusions, { flag: 'wx' });
  await log(`==> Detected stack: ${detection.stack}`);
  await log(`==> Evidence: ${detection.evidence.join(', ')}`);
  await log(`==> Parameters: ${JSON.stringify(detection.parameters)}`);
  // Wrap long JSON instructions so the existing per-line log cap does not
  // truncate their content. Redaction and total log budgets still apply.
  await log(`==> Generated .devflow/Dockerfile (long lines wrapped):\n${text.split('\n').flatMap((line) => line.match(/.{1,1000}/g) ?? ['']).join('\n')}`);
  return { rule, stack: detection.stack, evidence: detection.evidence, dockerfileDir: generatedDir, generated: true, warning };
}
