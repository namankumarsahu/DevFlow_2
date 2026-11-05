import { defaultBuildSettings, type BuildSettings } from '../components/BuildFields';
import type { EntryChoice, PreflightResult } from '../components/Requirements';

export type SetupForm = BuildSettings & { name: string; branch: string; environment: 'PRODUCTION' | 'STAGING' | 'DEVELOPMENT'; containerPort: number };
export const initialSetup = (): SetupForm => ({ ...defaultBuildSettings, name: '', branch: '', environment: 'PRODUCTION', containerPort: 3000 });
// null inherits devflow.json. An explicit no-op skips its release command without
// disabling unrelated repository defaults or changing the backend API contract.
export const SKIP_MIGRATIONS = 'true # DevFlow: skip migrations';
export function repositoryIdentity(raw: string) {
  let url: URL;
  try { url = new URL(raw.trim()); } catch { throw new Error('Use https://github.com/owner/repository.'); }
  const parts = /^\/([\w.-]+)\/([\w.-]+)\/?$/.exec(url.pathname);
  if (url.protocol !== 'https:' || url.host !== 'github.com' || url.username || url.password || url.search || url.hash || !parts) throw new Error('Use https://github.com/owner/repository.');
  const owner = parts[1], repo = parts[2].replace(/\.git$/i, '');
  if (!repo) throw new Error('Enter a repository name.');
  return { owner, repo, name: repo.slice(0, 60), url: `https://github.com/${owner}/${repo}` };
}
export async function defaultBranch(repo: ReturnType<typeof repositoryIdentity>, signal?: AbortSignal) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, 15000);
  try {
    if (signal?.aborted) controller.abort();
    const response = await fetch(`https://api.github.com/repos/${repo.owner}/${repo.repo}`, {
      headers: { Accept: 'application/vnd.github+json' }, credentials: 'omit', referrerPolicy: 'no-referrer', signal: controller.signal,
    });
    if (!response.ok) throw new Error(`GitHub returned HTTP ${response.status}.`);
    const data = await response.json();
    if (typeof data.default_branch !== 'string' || !/^[\w][\w./-]*$/.test(data.default_branch) || data.default_branch.length > 100) throw new Error('GitHub did not return a supported default branch.');
    return data.default_branch as string;
  } catch {
    throw new Error('Could not read the default branch from GitHub. Retry, or enter the branch in Advanced settings.');
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}
export const choiceKey = (choice: EntryChoice) => JSON.stringify([choice.rootDir, choice.preset, choice.entrypoint]);
export function mergeChoices(previous: EntryChoice[], next: EntryChoice[] = []) {
  return [...new Map([...previous, ...next].map(choice => [choiceKey(choice), choice])).values()];
}
export function choiceSettings(form: SetupForm, choice: EntryChoice): SetupForm {
  return { ...form, useRepositoryConfig: false, rootDir: choice.rootDir, preset: choice.preset, entrypoint: choice.entrypoint, buildMode: 'AUTO' };
}
export type ScopeChoice = { id: string; label: string; settings: Pick<SetupForm, 'rootDir' | 'preset' | 'entrypoint' | 'useRepositoryConfig' | 'buildMode'> };
export function scopeChoices(report: PreflightResult, form: SetupForm): ScopeChoice[] {
  if (report.plan?.scope !== 'cohosted-frontend-api' || report.plan.components.length !== 2) return [];
  const { rootDir, preset, entrypoint, useRepositoryConfig, buildMode } = form;
  return [
    { id: 'both', label: 'Both', settings: { rootDir, preset, entrypoint, useRepositoryConfig, buildMode } },
    ...report.plan.components.map((component, index) => ({ id: index ? 'backend' : 'frontend', label: index ? 'Backend only' : 'Frontend only',
      settings: { rootDir: component.root, preset: null, entrypoint: null, useRepositoryConfig: false, buildMode: 'AUTO' as const } })),
  ];
}
export function setupBody(form: SetupForm, repo: ReturnType<typeof repositoryIdentity>, branch: string) {
  return { ...form, name: form.name.trim() || repo.name, branch, repoUrl: repo.url };
}
export function canDeploy(report?: PreflightResult) {
  return !!report?.plan && report.status !== 'unsupported' && !report.findings.some(f => f.severity === 'blocker');
}
