import { at, entry, file, names } from './files';
import { Detection, NodeApp, PythonApp, StaticApp } from './types';

export async function detectStatic(repo: string, root = '.'): Promise<Detection | null> {
  for (const output of ['.', 'dist', 'build', 'public', 'out']) {
    const index = at(root, output === '.' ? 'index.html' : `${output}/index.html`);
    if (await file(repo, index) !== null) {
      const parameters: StaticApp = { kind: 'static', root, output };
      return { strategyId: 'static', stack: 'Static site', evidence: [index], parameters };
    }
  }
  return null;
}

export async function detectNode(repo: string, root = '.'): Promise<Detection | null> {
  const manifest = at(root, 'package.json');
  const raw = await file(repo, manifest);
  if (raw === null) return null;
  let pkg: any;
  try { pkg = JSON.parse(raw); } catch { throw new Error(`Invalid JSON in ${manifest}`); }
  if (!pkg || typeof pkg !== 'object' || Array.isArray(pkg)) throw new Error(`Invalid package manifest: ${manifest}`);
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const framework = deps.vite ? 'vite' : deps['react-scripts'] ? 'cra' : deps.next ? 'next' : 'node';
  const locks = ['package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml'];
  const found: string[] = [];
  for (const name of locks) if ((await entry(repo, at(root, name)))?.isFile()) found.push(name);
  if (new Set(found.map((n) => n === 'yarn.lock' ? 'yarn' : n === 'pnpm-lock.yaml' ? 'pnpm' : 'npm')).size > 1) {
    throw new Error(`Ambiguous package manager in ${root}; keep only one manager's lockfile`);
  }
  const manager = found.includes('yarn.lock') ? 'yarn' : found.includes('pnpm-lock.yaml') ? 'pnpm' : 'npm';
  const requested = typeof pkg.packageManager === 'string' && /^(yarn|pnpm)@\d+\.\d+\.\d+$/.test(pkg.packageManager) ? pkg.packageManager : '';
  const modernYarn = (await file(repo, at(root, 'yarn.lock')))?.includes('__metadata:');
  const managerVersion = manager === 'npm' ? '' : requested.startsWith(manager + '@') ? requested : manager === 'pnpm' ? 'pnpm@9.15.9' : modernYarn ? 'yarn@4.5.3' : 'yarn@1.22.22';
  const major = /(?:^|[\s^~>=|])(22|24)(?:\D|$)/.exec(String(pkg.engines?.node ?? ''))?.[1] ?? '22';
  const main = typeof pkg.main === 'string' && /^[\w./-]+$/.test(pkg.main) && !pkg.main.split('/').includes('..') ? pkg.main : null;
  const parameters: NodeApp = {
    kind: 'node', root, framework, image: `node:${major}-alpine`, manager, managerVersion,
    manifests: ['package.json', ...found], hasBuild: typeof pkg.scripts?.build === 'string',
    hasStart: typeof pkg.scripts?.start === 'string', main, output: framework === 'cra' ? 'build' : 'dist',
  };
  return { strategyId: 'node', stack: framework === 'node' ? deps['@nestjs/core'] ? 'NestJS' : deps.express ? 'Express' : 'Node' : framework === 'next' ? 'Next.js' : framework === 'cra' ? 'Create React App' : 'Vite', evidence: parameters.manifests.map((n) => at(root, n)), parameters };
}

export async function pythonEntrypoints(repo: string, root = '.') {
  const available = await names(repo, root);
  const candidates: { framework: PythonApp['framework']; target: string; evidence: string }[] = [];
  for (const name of available.filter((n) => n.endsWith('.py'))) {
    const relative = root === '.' ? name : name.slice(root.length + 1);
    if (!/^(?:[A-Za-z_]\w*\/)*[A-Za-z_]\w*\.py$/.test(relative)) continue;
    const source = await file(repo, name) ?? '';
    const module = relative.slice(0, -3).replace(/\//g, '.');
    if (relative.endsWith('/wsgi.py') && await entry(repo, at(root, relative.replace(/wsgi\.py$/, 'settings.py')))) {
      candidates.push({ framework: 'django', target: `${module}:application`, evidence: name });
    }
    for (const [framework, factory] of [['flask', 'Flask'], ['fastapi', 'FastAPI']] as const) {
      const pattern = new RegExp(`(?:^|\\n)([A-Za-z_]\\w*)[ \\t]*(?::[^=\\n]+)?=[ \\t]*${factory}[ \\t]*\\(`, 'g');
      for (const match of source.matchAll(pattern)) candidates.push({ framework, target: `${module}:${match[1]}`, evidence: name });
    }
  }
  return candidates;
}
export async function detectPython(repo: string, root = '.', force?: PythonApp['framework'], target?: string | null): Promise<Detection | null> {
  const req = await file(repo, at(root, 'requirements.txt'));
  const pyproject = await file(repo, at(root, 'pyproject.toml'));
  if (req === null && pyproject === null) return null;
  const manifest = req !== null ? 'requirements.txt' : 'pyproject.toml';
  const dependencies = `${req ?? ''}\n${pyproject ?? ''}`;
  const candidates = await pythonEntrypoints(repo, root);
  const selected = candidates.filter(c => (!force || c.framework === force) && (!target || c.target === target));
  if (target && !selected.length) throw new Error('Selected Python entry point was not found in the source files');
  if (selected.length > 1) throw new Error(`Ambiguous Python entry point in ${root}; keep one app entry point or supply your own Dockerfile`);
  let candidate = selected[0];
  const framework = force ?? candidate?.framework ?? (/\bdjango\b/i.test(dependencies) ? 'django' : /\bfastapi\b/i.test(dependencies) ? 'fastapi' : /\bflask\b/i.test(dependencies) ? 'flask' : null);
  if (!framework) return null;
  if (!candidate && framework === 'django') throw new Error(`No Django settings.py + wsgi.py module found in ${root}; add a Dockerfile with an explicit entry point`);
  if (!candidate) throw new Error(`No module-level Python HTTP application found in ${root}; use a Dockerfile for factory/dynamic entry points`);
  const parameters: PythonApp = { kind: 'python', root, framework, manifest, target: candidate.target, server: framework === 'fastapi' ? 'uvicorn' : 'gunicorn' };
  if (framework === 'django') {
    const wsgi = await file(repo, candidate.evidence) ?? '';
    parameters.settingsModule = /["']DJANGO_SETTINGS_MODULE["']\s*,\s*["']([\w.]+)["']/.exec(wsgi)?.[1] ?? candidate.target.split(':')[0].replace(/wsgi$/, 'settings');
  }
  return { strategyId: 'python', stack: framework === 'django' ? 'Django' : framework === 'flask' ? 'Flask' : 'FastAPI', evidence: [at(root, manifest), candidate.evidence], parameters };
}

export async function detectFullstack(repo: string): Promise<Detection | null> {
  const frontends: string[] = [], backends: string[] = [];
  for (const root of ['frontend', 'client', 'web']) if ((await entry(repo, root))?.isDirectory()) frontends.push(root);
  for (const root of ['backend', 'server', 'api']) if ((await entry(repo, root))?.isDirectory()) backends.push(root);
  if (!frontends.length || !backends.length) return null;
  if (frontends.length !== 1 || backends.length !== 1) throw new Error('Ambiguous frontend/backend layout; keep one frontend and one backend folder, select a preset, or add a Dockerfile');
  const frontend = await detectNode(repo, frontends[0]) ?? await detectStatic(repo, frontends[0]);
  const backend = await detectNode(repo, backends[0]) ?? await detectPython(repo, backends[0]);
  if (!frontend || !backend || frontend.parameters.kind === 'node' && !['vite', 'cra'].includes(frontend.parameters.framework)) {
    throw new Error('Unsupported frontend/backend layout: use a Vite/CRA/static frontend and a Node/Django/Flask/FastAPI backend, select a preset, or add a Dockerfile');
  }
  return { strategyId: 'fullstack', stack: `Frontend + ${backend.stack}`, evidence: [...frontend.evidence, ...backend.evidence], parameters: { kind: 'fullstack', frontend: frontend.parameters as NodeApp | StaticApp, backend: backend.parameters as NodeApp | PythonApp } };
}
