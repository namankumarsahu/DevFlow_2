import { Request, Router } from 'express';
import { prisma } from '../db';
import { HttpError } from '../lib/errors';
import { authenticate } from '../middleware/auth';
import { cancelDeployment, requestDeployment } from '../services/deployments';
import { deployBurstLimiter } from '../middleware/limiters';
import { getAccessibleProject } from './projects';
import { validHealthPath } from '../lib/autobuild/configuration';

export const deploymentsRouter = Router();
deploymentsRouter.use(authenticate);

async function getAccessibleDeployment(req: Request, id: string) {
  const d = await prisma.deployment.findUnique({ where: { id } });
  if (!d) throw new HttpError(404, 'Deployment not found');
  await getAccessibleProject(req, d.projectId); // enforces ownership
  return d;
}

deploymentsRouter.get('/:id', async (req, res) => {
  res.json(await getAccessibleDeployment(req, req.params.id));
});

deploymentsRouter.get('/:id/logs', async (req, res) => {
  const d = await getAccessibleDeployment(req, req.params.id);
  const logs = await prisma.deploymentLog.findMany({ where: { deploymentId: d.id }, orderBy: { id: 'asc' } });
  res.json(logs.map((l) => ({ line: l.line, ts: l.createdAt })));
});

// Rollback = new deployment that re-runs a previously built image (no clone/build).
deploymentsRouter.post('/:id/rollback', deployBurstLimiter, async (req, res) => {
  const target = await getAccessibleDeployment(req, String(req.params.id));
  const project = await getAccessibleProject(req, target.projectId); // ownership, and the owner whose quota is used
  if (target.previewId) throw new HttpError(409, 'Preview deployments cannot be rolled back; push a new commit to the pull request');
  if (target.status !== 'SUCCESS' || !target.imageTag) {
    throw new HttpError(409, 'Can only roll back to a previous successful deployment');
  }
  const recorded = target.preflight as { plan?: { healthPath?: unknown; healthMode?: unknown }; rollbackHealthPath?: unknown; rollbackHealthMode?: unknown } | null;
  const healthPath = recorded?.plan?.healthPath ?? recorded?.rollbackHealthPath;
  const healthMode = recorded?.plan?.healthMode ?? recorded?.rollbackHealthMode;
  const d = await requestDeployment(project, req.user!.id, {
    id: target.id,
    imageTag: target.imageTag,
    commitHash: target.commitHash,
    detectedStack: target.detectedStack,
    buildRule: target.buildRule,
    healthPath: typeof healthPath === 'string' && validHealthPath(healthPath) ? healthPath : undefined,
    healthMode: healthMode === 'readiness' || healthMode === 'liveness' ? healthMode : undefined,
  });
  res.status(202).json(d);
});

deploymentsRouter.post('/:id/cancel', async (req, res) => {
  const d = await getAccessibleDeployment(req, req.params.id);
  await cancelDeployment(d);
  res.status(202).json({ id: d.id, cancelling: true });
});
