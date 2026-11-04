import { mkdir, mkdtemp, rm } from 'fs/promises';
import path from 'path';
import { config } from '../config';
import { prisma } from '../db';
import { HttpError } from '../lib/errors';
import { childEnv, GIT_ENV, gitCloneArgs } from '../lib/buildSandbox';
import { runProcess } from '../lib/runProcess';
import { dirSizeBytes } from '../lib/repoSize';
import { preflightKey, PreflightResult, PreflightSettings, summarize } from '../lib/autobuild/preflight';
import { analyzeDeployment } from '../lib/autobuild/analyze';
import { effectiveLimits, OwnerRole, ResourceLimits } from '../lib/limits';

async function planContext(project: PreflightSettings & Partial<ResourceLimits> & { ownerId?: string }) {
  const owner = project.ownerId ? await prisma.user.findUnique({ where: { id: project.ownerId }, select: { role: true } }) : null;
  return { port: project.containerPort ?? 3000, healthPath: config.healthPath, limits: effectiveLimits(project as ResourceLimits, (owner?.role ?? 'USER') as OwnerRole, config.maxLimits, config.defaultLimits) };
}

let active = 0;
const checking = new Set<string>();
export async function checkProject(project: PreflightSettings & { id: string; ownerId: string; repoUrl: string; branch: string; preflight?: unknown; preflightAt?: Date | null; preflightKey?: string | null }, force = false): Promise<PreflightResult> {
  const env = await prisma.envVar.findMany({ where: { projectId: project.id }, select: { key: true } });
  const envNames = env.map((v) => v.key);
  const context = await planContext(project);
  const key = preflightKey(project, envNames, context);
  if (!force && project.preflight && project.preflightKey === key && project.preflightAt && Date.now() - project.preflightAt.getTime() < 5 * 60_000) return project.preflight as PreflightResult;
  if (active >= 2 || checking.has(project.ownerId)) throw new HttpError(429, 'A requirements check is already running. Try again shortly.', { code: 'PREFLIGHT_BUSY', headers: { 'Retry-After': '5' } });
  checking.add(project.ownerId); active++;
  let tmp: string | undefined;
  try {
    await mkdir(config.workDir, { recursive: true });
    tmp = await mkdtemp(path.join(config.workDir, 'preflight-'));
    const repo = path.join(tmp, 'repo');
    const maxBytes = config.maxRepoMb * 1024 * 1024;
    const clone = await runProcess({ cmd: 'git', args: gitCloneArgs(project.branch, project.repoUrl, repo), env: childEnv(process.env, GIT_ENV), timeoutMs: Math.min(60_000, config.deployTimeoutMs), watchDirectory: { path: repo, maxBytes } }).catch(() => ({ outcome: 'failed' as const }));
    let result: PreflightResult;
    if (clone.outcome !== 'ok' || await dirSizeBytes(repo, maxBytes) > maxBytes) {
      result = summarize([{ id: 'repo.clone', severity: 'blocker', message: clone.outcome === 'too-large' ? 'Repository exceeds MAX_REPO_MB.' : 'The repository could not be inspected within the bounded clone budget.', evidence: [{ file: '.', line: 1 }], fix: 'Check the public repository URL, branch, TLS trust and repository size, then retry.' }], null, 'preflight');
    } else {
      result = (await analyzeDeployment(repo, project, envNames, context, config.build.maxDockerfileKb * 1024)).report;
    }
    // A settings/env-name change during a clone must not attach a stale result.
    const latest = await prisma.project.findUnique({ where: { id: project.id } });
    const latestEnv = await prisma.envVar.findMany({ where: { projectId: project.id }, select: { key: true } });
    if (!latest || preflightKey(latest, latestEnv.map((v) => v.key), await planContext(latest)) !== key) throw new HttpError(409, 'Settings changed during the check. Run Requirements again.', { code: 'PREFLIGHT_STALE' });
    await prisma.project.update({ where: { id: project.id }, data: { preflight: JSON.parse(JSON.stringify(result)), preflightAt: new Date(), preflightKey: key } });
    return result;
  } finally {
    if (tmp) await rm(tmp, { recursive: true, force: true });
    checking.delete(project.ownerId); active--;
  }
}

export async function checkKnownRequirements(project: { id: string }, actorId: string | null, override = false, planId?: string) {
  if (override) {
    const actor = actorId ? await prisma.user.findUnique({ where: { id: actorId }, select: { role: true } }) : null;
    if (actor?.role !== 'ADMIN') throw new HttpError(403, 'Only admins can override preflight blockers');
  }
  const current = await prisma.project.findUnique({ where: { id: project.id } });
  if (!current?.preflight) {
    if (planId) throw new HttpError(409, 'Review Requirements again before deploying.', { code: 'PREFLIGHT_STALE' });
    return; // API clients without a prior check are still checked by the worker.
  }
  const env = await prisma.envVar.findMany({ where: { projectId: project.id }, select: { key: true } });
  if (!current.preflightAt || Date.now() - current.preflightAt.getTime() >= 5 * 60_000 || current.preflightKey !== preflightKey(current, env.map((v) => v.key), await planContext(current))) throw new HttpError(409, 'Requirements changed or expired; run preflight again.', { code: 'PREFLIGHT_STALE' });
  if (planId && (current.preflight as any).plan?.id !== planId) throw new HttpError(409, 'The reviewed deployment plan changed. Check Requirements again.', { code: 'PREFLIGHT_STALE' });
  const result = current.preflight as unknown as PreflightResult;
  if (!override && result.findings.some((f) => f.severity === 'blocker')) throw new HttpError(422, 'Resolve Requirements blockers before deploying.', { code: 'PREFLIGHT_BLOCKED', data: { preflight: result } });
}
