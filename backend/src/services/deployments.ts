import { config } from '../config';
import { prisma } from '../db';
import { HttpError } from '../lib/errors';
import { publishStatus } from '../lib/events';
import { getQueue } from '../queue';
import { getRedis } from '../redis';
import { assertCanDeploy, quotaApplies, recordAttempt, withUserLock } from './quota';
import { checkKnownRequirements } from './preflight';

type RollbackSource = { id: string; imageTag: string; commitHash: string | null; detectedStack?: string | null; buildRule?: string | null; healthPath?: string; healthMode?: 'readiness' | 'liveness' };
type DeployOptions = { previewId?: string; overridePreflight?: boolean; planId?: string };

const deploymentData = (projectId: string, userId: string | null, rollback?: RollbackSource, opts: DeployOptions = {}) => ({
  projectId,
  triggeredById: userId,
  status: 'QUEUED' as const,
  previewId: opts.previewId,
  rollbackOfId: rollback?.id,
  imageTag: rollback?.imageTag,
  commitHash: rollback?.commitHash,
  detectedStack: rollback?.detectedStack,
  buildRule: rollback?.buildRule,
  preflightOverride: opts.overridePreflight ?? false,
  ...(opts.planId || rollback?.healthPath ? { preflight: { ...(opts.planId ? { reviewedPlanId: opts.planId } : {}), ...(rollback?.healthPath ? { rollbackHealthPath: rollback.healthPath, rollbackHealthMode: rollback.healthMode ?? (rollback.healthPath === '/' ? 'liveness' : 'readiness') } : {}) } } : {}),
});

// Hand a freshly created QUEUED row to the worker. If Redis is unreachable the row must not stay QUEUED forever
// (it would count as "in progress" for the user), so it is failed right away.
async function dispatch(deployment: { id: string }) {
  try {
    await getQueue().add('deploy', { deploymentId: deployment.id }, { jobId: deployment.id, attempts: 1 });
  } catch (e) {
    await prisma.deployment
      .update({ where: { id: deployment.id }, data: { status: 'FAILED', error: 'Could not queue the deployment', finishedAt: new Date() } })
      .catch(() => undefined);
    console.error('Queue add failed:', e);
    throw new HttpError(503, 'Could not queue the deployment, please try again');
  }
}

// No quota checks. Used for system-initiated work (admin re-applies limits) and when demo mode is off.
export async function enqueueDeployment(
  projectId: string,
  userId: string | null,
  rollback?: RollbackSource,
  opts: DeployOptions = {},
) {
  const deployment = await prisma.deployment.create({ data: deploymentData(projectId, userId, rollback, opts) });
  await dispatch(deployment);
  return deployment;
}

// Every user-facing way of starting a production deployment (deploy button, rollback, GitHub push webhook) goes
// through here. In demo mode the quota checks and the new Deployment row happen in ONE transaction that holds a
// lock on the project owner, so concurrent requests cannot exceed the limits. The quota belongs to the project
// OWNER, whoever (or whatever webhook) triggers it.
export async function requestDeployment(project: { id: string; ownerId: string }, actorId: string | null, rollback?: RollbackSource, opts: DeployOptions = {}) {
  if (!rollback) await checkKnownRequirements(project, actorId, opts.overridePreflight, opts.planId);
  if (!config.demo.enabled) return enqueueDeployment(project.id, actorId, rollback, opts);
  const deployment = await withUserLock(project.ownerId, async (tx, role) => {
    if (quotaApplies(role)) {
      await assertCanDeploy(tx, project.ownerId, project.id);
      await recordAttempt(tx, project.ownerId);
    }
    return tx.deployment.create({ data: deploymentData(project.id, actorId, rollback, opts) });
  });
  await dispatch(deployment);
  return deployment;
}

export async function cancelDeployment(d: { id: string; status: string }) {
  if (d.status === 'QUEUED') {
    // The worker re-checks status after it acquires the project lock, so a job that
    // is already active (waiting for the lock) also stops cleanly.
    await getQueue().getJob(d.id).then((j) => j?.remove()).catch(() => undefined);
    await prisma.deployment.update({
      where: { id: d.id },
      data: { status: 'CANCELLED', finishedAt: new Date() },
    });
    await publishStatus(d.id, 'CANCELLED');
  } else if (d.status === 'BUILDING' || d.status === 'DEPLOYING') {
    // Worker polls this key and kills the running child process.
    await getRedis().set(`cancel:${d.id}`, '1', 'EX', 3600);
  } else {
    throw new HttpError(409, `Deployment already ${d.status.toLowerCase()}`);
  }
}

export const enqueueTeardown = (projectId: string) =>
  getQueue().add('teardown', { projectId }, { attempts: 1 });

// Step 14: remove a closed PR's containers (the worker waits for any in-flight build of that preview first).
export const enqueuePreviewTeardown = (previewId: string) =>
  getQueue().add('preview-teardown', { previewId }, { attempts: 1 });
