import { readdir, rm, stat } from 'fs/promises';
import path from 'path';
import { config } from '../config';
import { prisma } from '../db';
import { deploymentContainerName } from './caddyConfig';

// Safety net for work that nobody is doing any more: a worker that crashed or was redeployed mid-build leaves its
// deployment BUILDING / DEPLOYING (or QUEUED with a lost job) forever. That would count against the user's
// one-build-at-a-time rule and quota. The normal timeout path never relies on this; it only catches lost workers.
export type ReaperIO = { removeContainer: (name: string) => Promise<void> };

const GRACE_MS = 2 * 60 * 1000;

export async function reapStaleDeployments(io: ReaperIO, now = Date.now()): Promise<string[]> {
  const startedBefore = new Date(now - (config.deployTimeoutMs + GRACE_MS));
  const queuedBefore = new Date(now - config.demo.staleAfterMs);
  const stale: { id: string; projectId: string }[] = await prisma.deployment.findMany({
    where: {
      OR: [
        { status: { in: ['BUILDING', 'DEPLOYING'] }, startedAt: { lt: startedBefore } },
        { status: 'QUEUED', createdAt: { lt: queuedBefore } },
      ],
    },
    select: { id: true, projectId: true },
    take: 100,
  });
  for (const d of stale) {
    // Guarded update: only touches the row if it is still in a non-terminal state (the worker may have just finished it).
    const { count } = await prisma.deployment.updateMany({
      where: { id: d.id, status: { in: ['QUEUED', 'BUILDING', 'DEPLOYING'] } },
      data: { status: 'FAILED', error: 'Timed out: the worker stopped responding while processing this deployment', finishedAt: new Date() },
    });
    if (count) await io.removeContainer(deploymentContainerName(d.projectId, d.id)).catch(() => undefined);
  }
  return stale.map((d) => d.id);
}

// Leftover clones / env files / image tarballs from builds that died without running their cleanup.
export async function sweepWorkDir(dir = config.workDir, now = Date.now()): Promise<string[]> {
  const olderThan = Math.max(60 * 60 * 1000, config.deployTimeoutMs * 3);
  const removed: string[] = [];
  let names: string[] = [];
  try {
    names = await readdir(dir);
  } catch {
    return removed; // directory does not exist yet
  }
  for (const n of names) {
    const p = path.join(dir, n);
    try {
      if (now - (await stat(p)).mtimeMs > olderThan) {
        await rm(p, { recursive: true, force: true });
        removed.push(n);
      }
    } catch {
      /* raced with a normal cleanup */
    }
  }
  return removed;
}
