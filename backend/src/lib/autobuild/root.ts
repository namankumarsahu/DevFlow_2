import path from 'path';
import { entry } from './files';

export const normalizeRootDir = (value?: string | null) => (value?.trim() || '.').replace(/^\.\//, '') || '.';
export function validRootDir(value: string) {
  const root = normalizeRootDir(value);
  return root.length <= 200 && (root === '.' || /^[\w.-]+(?:\/[\w.-]+)*$/.test(root) && root.split('/').every(part => part !== '.' && part !== '..'));
}
// The build context must stay inside the clone, without traversing symlinks.
export async function appRoot(repoDir: string, value?: string | null) {
  const root = normalizeRootDir(value);
  if (!validRootDir(root)) throw new Error('Root directory must be a relative folder inside the repository');
  if (!(await entry(repoDir, root))?.isDirectory()) throw new Error('Selected root directory does not exist');
  return path.join(repoDir, root);
}
