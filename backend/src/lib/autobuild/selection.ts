import { detectPython } from './detect';
import { strategies } from './registry';
import { Detection, Preset, StrategyId } from './types';

export const supported = 'Supported stacks: static sites, Node (Vite, CRA, Next.js, Express/Nest), Django, Flask, FastAPI, and frontend + backend monorepos. Pick a preset in project settings or add a Dockerfile.';
const presetStrategy: Record<Preset, StrategyId> = { STATIC: 'static', NODE: 'node', PYTHON_DJANGO: 'python', PYTHON_FLASK: 'python', PYTHON_FASTAPI: 'python', FULLSTACK: 'fullstack' };
export async function detect(repoDir: string, entrypoint?: string | null): Promise<Detection> {
  if (entrypoint) {
    const selected = await detectPython(repoDir, '.', undefined, entrypoint);
    if (!selected) throw new Error('Selected Python entry point was not found');
    return selected;
  }
  for (const strategy of strategies) {
    const detection = await strategy.detect(repoDir);
    if (detection) return detection;
  }
  throw new Error(`Could not auto-detect this repository. ${supported}`);
}
export async function detectPreset(repoDir: string, preset: Preset, entrypoint?: string | null): Promise<Detection> {
  const strategy = strategies.find((s) => s.id === presetStrategy[preset]);
  const framework = preset === 'PYTHON_DJANGO' ? 'django' : preset === 'PYTHON_FLASK' ? 'flask' : preset === 'PYTHON_FASTAPI' ? 'fastapi' : null;
  if (entrypoint && !framework) throw new Error('Python entry point requires a Python preset or auto-detection');
  const detection = framework ? await detectPython(repoDir, '.', framework, entrypoint) : await strategy?.detect(repoDir);
  if (!detection) throw new Error(`Preset ${preset} needs its manifest and entry point in the repository. ${supported}`);
  if (preset === 'NODE' && detection.parameters.kind === 'node') {
    detection.parameters.framework = 'node'; detection.stack = 'Node';
  }
  return detection;
}
