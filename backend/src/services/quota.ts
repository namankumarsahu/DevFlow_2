import { config } from '../config';
import { prisma } from '../db';
import { HttpError } from '../lib/errors';

// Demo-mode quotas. Everything here runs on the server; the dashboard only displays it.
//
// Concurrency: every quota-changing operation for one user runs inside a transaction that first takes a row lock on
// that user (SELECT ... FOR UPDATE). Two concurrent requests for the same user are therefore serialised by Postgres:
// the second one only starts counting after the first one has committed its Deployment / DeploymentAttempt row.
export const ACTIVE_STATUSES = ['QUEUED', 'BUILDING', 'DEPLOYING'] as const;

export type Db = Pick<typeof prisma, 'user' | 'project' | 'deployment' | 'deploymentAttempt' | '$queryRaw'>;
export type OwnerRole = 'USER' | 'ADMIN';

// Quotas apply to ordinary users while demo mode is on. Admins are the operators of the platform.
export const quotaApplies = (role: OwnerRole) => config.demo.enabled && role !== 'ADMIN';

export async function withUserLock<T>(userId: string, fn: (tx: Db, role: OwnerRole) => Promise<T>): Promise<T> {
  return prisma.$transaction(
    async (tx: Db) => {
      const rows = await tx.$queryRaw<{ id: string; role: string }[]>`SELECT "id", "role"::text AS "role" FROM "User" WHERE "id" = ${userId} FOR UPDATE`;
      if (!rows[0]) throw new HttpError(404, 'User not found');
      return fn(tx, rows[0].role as OwnerRole);
    },
    { maxWait: 5000, timeout: 10_000 },
  );
}

export type Usage = {
  activeApps: number;
  activeProjectIds: string[];
  inFlight: { deploymentId: string; projectId: string } | null;
  projectCount: number;
  attemptsInWindow: number;
  attemptsResetAt: Date | null; // when the oldest counted attempt leaves the window
};

export async function computeUsage(tx: Db, ownerId: string, now = Date.now()): Promise<Usage> {
  const staleCutoff = new Date(now - config.demo.staleAfterMs);
  const since = new Date(now - config.demo.deployWindowMs);
  const projects: { id: string; currentDeploymentId: string | null }[] = await tx.project.findMany({
    where: { ownerId },
    select: { id: true, currentDeploymentId: true },
  });
  const ids = projects.map((p) => p.id);
  // In flight = resource-consuming but not yet running. Rows older than staleAfterMs are dead (worker lost) and ignored.
  const inflight: { id: string; projectId: string }[] = ids.length
    ? await tx.deployment.findMany({
        where: { projectId: { in: ids }, previewId: null, status: { in: [...ACTIVE_STATUSES] }, createdAt: { gte: staleCutoff } },
        select: { id: true, projectId: true },
        orderBy: { createdAt: 'asc' },
      })
    : [];
  const attempts: { createdAt: Date }[] = await tx.deploymentAttempt.findMany({
    where: { userId: ownerId, createdAt: { gte: since } },
    select: { createdAt: true },
    orderBy: { createdAt: 'asc' },
  });
  // Active application = has a running version (currentDeploymentId) OR a first version still being built.
  // A project whose only deployments FAILED / were CANCELLED has neither, so it holds no slot.
  const active = new Set<string>(projects.filter((p) => p.currentDeploymentId).map((p) => p.id));
  inflight.forEach((d) => active.add(d.projectId));
  return {
    activeApps: active.size,
    activeProjectIds: [...active],
    inFlight: inflight[0] ? { deploymentId: inflight[0].id, projectId: inflight[0].projectId } : null,
    projectCount: projects.length,
    attemptsInWindow: attempts.length,
    attemptsResetAt: attempts[0] ? new Date(attempts[0].createdAt.getTime() + config.demo.deployWindowMs) : null,
  };
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

// Throws when this user may not start another deployment of `projectId` right now.
export async function assertCanDeploy(tx: Db, ownerId: string, projectId: string, now = Date.now()): Promise<Usage> {
  const u = await computeUsage(tx, ownerId, now);
  const { maxActiveApps, maxDeploysPerHour } = config.demo;

  // 1. Active-application quota. Redeploying an app that already holds a slot never needs a new one.
  if (!u.activeProjectIds.includes(projectId) && u.activeApps >= maxActiveApps) {
    throw new HttpError(
      403,
      `Demo limit reached: you already have ${u.activeApps} of ${maxActiveApps} active deployments. Delete one of your deployed apps to free a slot, then deploy again.`,
      { code: 'ACTIVE_APP_QUOTA_REACHED', data: { activeApps: u.activeApps, maxActiveApps } },
    );
  }
  // 2. One build at a time per user.
  if (u.inFlight) {
    throw new HttpError(409, 'You already have a deployment in progress. Wait for it to finish (or cancel it) before starting another.', {
      code: 'BUILD_IN_PROGRESS',
      data: { deploymentId: u.inFlight.deploymentId, projectId: u.inFlight.projectId },
    });
  }
  // 3. Deployment attempts per rolling hour.
  if (u.attemptsInWindow >= maxDeploysPerHour) {
    const retryAfterSeconds = Math.max(1, Math.ceil(((u.attemptsResetAt?.getTime() ?? now) - now) / 1000));
    throw new HttpError(
      429,
      `Deployment limit reached: ${plural(maxDeploysPerHour, 'deployment attempt')} per hour. Try again in ${Math.ceil(retryAfterSeconds / 60)} minute(s).`,
      {
        code: 'DEPLOY_RATE_LIMITED',
        data: { attempts: u.attemptsInWindow, maxAttempts: maxDeploysPerHour, retryAfterSeconds },
        headers: { 'Retry-After': String(retryAfterSeconds) },
      },
    );
  }
  return u;
}

// Record an accepted attempt (inside the same locked transaction) and drop entries older than a day.
export async function recordAttempt(tx: Db, userId: string, now = Date.now()) {
  await tx.deploymentAttempt.create({ data: { userId } });
  await tx.deploymentAttempt.deleteMany({ where: { userId, createdAt: { lt: new Date(now - 24 * 3600 * 1000) } } });
}

// Same numbers, without taking the lock: what the dashboard shows.
export async function getUsage(ownerId: string, role: OwnerRole) {
  const u = await computeUsage(prisma, ownerId);
  const since = new Date(Date.now() - 24 * 3600 * 1000);
  const failedLast24h: number = u.projectCount
    ? await prisma.deployment.count({ where: { project: { ownerId }, previewId: null, status: 'FAILED', createdAt: { gte: since } } })
    : 0;
  const enforced = quotaApplies(role);
  return {
    demoMode: config.demo.enabled,
    enforced,
    activeApps: { used: u.activeApps, max: enforced ? config.demo.maxActiveApps : null, projectIds: u.activeProjectIds },
    projects: { used: u.projectCount, max: enforced ? config.demo.maxProjects : null },
    // Distinct on purpose: attempts (every accepted request, incl. ones that later failed) vs apps holding a slot vs failures.
    deployAttempts: {
      used: u.attemptsInWindow,
      max: enforced ? config.demo.maxDeploysPerHour : null,
      windowMinutes: config.demo.deployWindowMs / 60_000,
      resetsAt: u.attemptsResetAt,
    },
    failedDeployments: { last24h: failedLast24h },
    build: { inFlight: u.inFlight, maxConcurrent: enforced ? 1 : null, timeoutSeconds: Math.round(config.deployTimeoutMs / 1000) },
  };
}
