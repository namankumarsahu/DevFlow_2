import { mkdir, writeFile } from 'fs/promises';
import path from 'path';
import { entry, file } from './files';
import { normalizeRootDir } from './root';
import { resolvePlan, ResolvedPlan } from './plan';
import { configuredSettings } from './configuration';
import { BuildPlan, BuildSettings, RenderContext } from './types';

export { supported, detect, detectPreset } from './selection';
export { analyzeDeployment } from './analyze';
// App code remains the build context. This Dockerfile-specific ignore file
// enforces exclusions even when the repository has permissive ! patterns.
export const generatedExclusions = [
  '**/.git', '**/.env', '**/.env.*', '**/node_modules', '**/tests', '**/test', '**/__tests__',
  '**/*.test.*', '**/*.spec.*', '**/test_*.py', '**/*_test.py', '**/tests.py', '**/conftest.py', '**/.pytest_cache', '**/__pycache__',
  '**/.venv', '**/venv', '**/.cache', '**/.devflow', '**/*.pem', '**/*.key',
].join('\n') + '\n';

export async function prepareBuild(cloneDir: string, settings: BuildSettings, ctx: RenderContext, maxBytes: number, log: (line: string) => Promise<void>, record: (meta: { rule: string; stack?: string }) => Promise<void> = async () => undefined, approved?: ResolvedPlan): Promise<BuildPlan> {
  const configured = approved ? { settings: approved.settings, source: approved.plan.configuration } : await configuredSettings(cloneDir, settings);
  settings = configured.settings;
  const resolved = approved ?? await resolvePlan(cloneDir, settings, ctx, maxBytes, null, [], [], configured.source);
  const { contextDir: repoDir, text, generated, warning, detection, plan } = resolved;
  if (normalizeRootDir(settings.rootDir) !== '.') await log(`==> Build root: ${normalizeRootDir(settings.rootDir)} (files outside this folder are excluded)`);
  await record({ rule: plan.rule, stack: plan.stack });
  await log(`==> Build rule: ${plan.rule}${settings.preset ? ' (' + settings.preset + ')' : ''}`);
  if (!generated) {
    await log('==> Build rule: repo Dockerfile (used unchanged)');
    return { rule: 'repo Dockerfile', stack: plan.stack, evidence: plan.evidence, dockerfileDir: repoDir, contextDir: repoDir, generated: false };
  }
  if (warning) await log(`==> WARNING: ${warning}`);
  const generatedDir = path.join(repoDir, '.devflow');
  if (await entry(repoDir, '.devflow/Dockerfile') || await entry(repoDir, '.devflow/Dockerfile.dockerignore')) throw new Error('Repository uses reserved .devflow/Dockerfile paths; remove them or use a root Dockerfile');
  await mkdir(generatedDir, { recursive: true });
  const originalIgnore = await file(repoDir, '.dockerignore') ?? '';
  await writeFile(path.join(generatedDir, 'Dockerfile'), text, { flag: 'wx' });
  await writeFile(path.join(generatedDir, 'Dockerfile.dockerignore'), originalIgnore + '\n' + generatedExclusions, { flag: 'wx' });
  await log(`==> Detected stack: ${plan.stack}`);
  await log(`==> Evidence: ${plan.evidence.join(', ')}`);
  await log(`==> Parameters: ${JSON.stringify(detection!.parameters)}`);
  await log(`==> Generated .devflow/Dockerfile (long lines wrapped):\n${text.split('\n').flatMap((line) => line.match(/.{1,1000}/g) ?? ['']).join('\n')}`);
  return { rule: plan.rule as BuildPlan['rule'], stack: plan.stack, evidence: plan.evidence, dockerfileDir: generatedDir, contextDir: repoDir, generated: true, warning };
}
