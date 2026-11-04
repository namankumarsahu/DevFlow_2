import { lstat, readFile, readdir } from 'fs/promises';
import path from 'path';

// Never follow a repository symlink, including intermediate directories. All
// detection is bounded, local file inspection; no imports, scripts or network.
export async function entry(repo: string, relative: string) {
  const parts = relative.split('/').filter((s) => s && s !== '.');
  if (parts.some((s) => s === '..' || s.includes('\\') || s.includes('\0'))) throw new Error('Unsafe repository path');
  let current = repo;
  for (const part of parts) {
    current = path.join(current, part);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) throw new Error(`Auto-build refuses symlink: ${relative}`);
    } catch (e: any) {
      if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return null;
      throw e;
    }
  }
  return lstat(current);
}
export const at = (root: string, name: string) => root === '.' ? name : `${root}/${name}`;
export async function file(repo: string, relative: string): Promise<string | null> {
  const info = await entry(repo, relative);
  if (!info?.isFile()) return null;
  if (info.size > 256 * 1024) throw new Error(`Auto-build manifest is too large: ${relative}`);
  return readFile(path.join(repo, relative), 'utf8');
}
export async function names(repo: string, root = '.', depth = 0): Promise<string[]> {
  if (depth > 4) return [];
  if (!(await entry(repo, root))?.isDirectory()) return [];
  const children = await readdir(path.join(repo, root), { withFileTypes: true });
  if (children.length > 500) throw new Error('Too many files for safe auto-detection; select a preset or add a Dockerfile');
  const result: string[] = [];
  for (const child of children.sort((a, b) => a.name.localeCompare(b.name))) {
    if (child.name.startsWith('.') || ['node_modules', 'tests', 'test', '__tests__', '__pycache__', 'venv'].includes(child.name)) continue;
    const relative = at(root, child.name);
    if (child.isFile()) result.push(relative);
    else if (child.isDirectory()) result.push(...await names(repo, relative, depth + 1));
    if (result.length > 2000) throw new Error('Too many files for safe auto-detection; select a preset or add a Dockerfile');
  }
  return result;
}
