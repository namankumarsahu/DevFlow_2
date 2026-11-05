import { readdir } from 'fs/promises';
import path from 'path';
import { entry } from './files';
import { detect } from './selection';
import { pythonEntrypoints } from './detect';
import { validRootDir } from './root';
import { Preset } from './types';

export type EntryChoice = { label: string; rootDir: string; preset: Preset | null; entrypoint: string | null; scope: string };
// Inspect only bounded directory names and manifests. Suggestions never run code.
export async function entryChoices(repo: string): Promise<EntryChoice[]> {
  const candidates = ['.'];
  async function folders(parent: string) {
    if (!(await entry(repo, parent))?.isDirectory()) return;
    const children = await readdir(path.join(repo, parent), { withFileTypes: true });
    if (children.length > 500) return;
    for (const child of children.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!child.isDirectory() || child.name.startsWith('.') || ['node_modules', 'tests', 'test', 'venv', 'dist', 'build'].includes(child.name)) continue;
      const relative = parent === '.' ? child.name : `${parent}/${child.name}`;
      if (validRootDir(relative) && candidates.length < 40) candidates.push(relative);
    }
  }
  await folders('.');
  for (const folder of ['apps', 'services']) await folders(folder);
  const result: EntryChoice[] = [];
  for (const root of candidates) {
    if (result.length >= 8) break;
    const selected = path.join(repo, root);
    try {
      if (await entry(repo, `${root}/Dockerfile`)) {
        result.push({ label: `${root}: Dockerfile`, rootDir: root, preset: null, entrypoint: null, scope: 'Only this directory; Dockerfile and image policies still apply.' });
        continue;
      }
      try {
        const detection = await detect(selected);
        const app = detection.parameters;
        const parts = app.kind === 'fullstack' ? [app.frontend, app.backend] : [app];
        if (parts.some(part => part.kind === 'node' && (part.workspaceLayout || part.workspaceDependencies))) continue;
        result.push({ label: `${root}: ${detection.stack}`, rootDir: root, preset: null, entrypoint: null,
          scope: app.kind === 'fullstack' ? 'Frontend and API in one container; external services remain separate.' : app.kind === 'static' || app.kind === 'node' && ['vite', 'cra'].includes(app.framework) ? 'Frontend only. A sibling API or database is excluded.' : 'Only this HTTP application; sibling applications are excluded.' });
      } catch {
        if (!await entry(selected, 'requirements.txt') && !await entry(selected, 'pyproject.toml')) continue;
        for (const app of await pythonEntrypoints(repo, root)) {
          if (result.length >= 8) break;
          result.push({ label: `${root}: ${app.target}`, rootDir: root, preset: app.framework === 'django' ? 'PYTHON_DJANGO' : app.framework === 'flask' ? 'PYTHON_FLASK' : 'PYTHON_FASTAPI', entrypoint: app.target, scope: 'Only this Python HTTP entry point. Other entry points are excluded.' });
        }
      }
    } catch { /* Unsafe/unreadable candidates are never suggested. */ }
  }
  return result;
}
