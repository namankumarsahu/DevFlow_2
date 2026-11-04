import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db';
import { HttpError } from '../lib/errors';
import { config } from '../config';
import { effectiveLimits, limitsDiffer, OwnerRole } from '../lib/limits';
import { authenticate, requireAdmin } from '../middleware/auth';
import { enqueueDeployment, enqueueTeardown } from '../services/deployments';
import { ACTIVE_STATUSES } from '../services/quota';
import { buildReliability } from '../lib/reliability';

export const adminRouter = Router();
adminRouter.use(authenticate, requireAdmin);

adminRouter.get('/build-reliability', async (_req, res) => {
  const rows = await prisma.deployment.findMany({ where: { previewId: null }, orderBy: { createdAt: 'asc' }, select: { projectId: true, detectedStack: true, status: true, preflight: true, failureClass: true, createdAt: true } });
  res.json({ stacks: buildReliability(rows), definition: 'First recorded project attempt; legacy uninspected rows and preflight-blocked attempts are excluded from the success denominator.' });
});

adminRouter.get('/stats', async (_req, res) => {
  const since = new Date(Date.now() - 7 * 24 * 3600 * 1000);
  const [users, projects, byStatus, avg, recent] = await Promise.all([
    prisma.user.count(),
    prisma.project.count(),
    prisma.deployment.groupBy({ by: ['status'], _count: true }),
    prisma.deployment.aggregate({ _avg: { durationMs: true }, where: { status: 'SUCCESS' } }),
    prisma.deployment.findMany({ where: { createdAt: { gte: since } }, select: { createdAt: true, status: true } }),
  ]);

  const counts: Record<string, number> = {};
  byStatus.forEach((s) => (counts[s.status] = s._count));
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const finished = (counts.SUCCESS ?? 0) + (counts.FAILED ?? 0);

  const days = new Map<string, { date: string; total: number; success: number; failed: number }>();
  for (let i = 6; i >= 0; i--) {
    const date = new Date(Date.now() - i * 24 * 3600 * 1000).toISOString().slice(0, 10);
    days.set(date, { date, total: 0, success: 0, failed: 0 });
  }
  recent.forEach((d) => {
    const b = days.get(d.createdAt.toISOString().slice(0, 10));
    if (!b) return;
    b.total++;
    if (d.status === 'SUCCESS') b.success++;
    if (d.status === 'FAILED') b.failed++;
  });

  res.json({
    users,
    projects,
    deployments: {
      total,
      byStatus: counts,
      successRate: finished ? (counts.SUCCESS ?? 0) / finished : null,
      avgDurationMs: avg._avg.durationMs ? Math.round(avg._avg.durationMs) : null,
    },
    last7Days: [...days.values()],
  });
});

adminRouter.get('/users', async (_req, res) => {
  const users = await prisma.user.findMany({
    orderBy: { createdAt: 'asc' },
    select: { id: true, email: true, role: true, createdAt: true, _count: { select: { projects: true } } },
  });
  res.json(users);
});

adminRouter.patch('/users/:id', async (req, res) => {
  const { role } = z.object({ role: z.enum(['USER', 'ADMIN']) }).parse(req.body);
  if (req.params.id === req.user!.id) throw new HttpError(400, 'You cannot change your own role');
  const user = await prisma.user.update({ where: { id: req.params.id }, data: { role } });
  res.json({ id: user.id, email: user.email, role: user.role });
});

adminRouter.delete('/users/:id', async (req, res) => {
  if (req.params.id === req.user!.id) throw new HttpError(400, 'You cannot delete yourself');
  // The database cascade removes the user's projects, but their containers would keep running (and no longer
  // count against any quota). Queue a teardown for every project first.
  const owned: { id: string }[] = await prisma.project.findMany({ where: { ownerId: req.params.id }, select: { id: true } });
  await prisma.user.delete({ where: { id: req.params.id } });
  for (const p of owned) await enqueueTeardown(p.id).catch((e) => console.error('Teardown enqueue failed:', e));
  res.status(204).end();
});

// Containers keep the limits they were started with. After lowering the defaults / maximum (for example when demo
// mode is switched on), this re-runs each live app's CURRENT image with the new limits through the normal blue/green
// path: the new container must pass its health check before traffic moves, and the old one keeps serving otherwise.
// It does not rebuild from git, so it never ships new code. System deployments do not use up a user's attempts.
adminRouter.post('/redeploy-out-of-policy', async (_req, res) => {
  const projects = await prisma.project.findMany({
    where: { currentDeploymentId: { not: null } },
    include: { owner: { select: { role: true } } },
  });
  const queued: { projectId: string; deploymentId: string }[] = [];
  const skipped: { projectId: string; reason: string }[] = [];
  for (const p of projects) {
    const current = await prisma.deployment.findUnique({ where: { id: p.currentDeploymentId! } });
    if (!current?.imageTag) { skipped.push({ projectId: p.id, reason: 'no stored image' }); continue; }
    const effective = effectiveLimits({ memoryMb: p.memoryMb, cpus: p.cpus, diskMb: p.diskMb }, p.owner.role as OwnerRole, config.maxLimits, config.defaultLimits);
    const applied = current.appliedMemoryMb != null && current.appliedCpus != null && current.appliedDiskMb != null
      ? { memoryMb: current.appliedMemoryMb, cpus: current.appliedCpus, diskMb: current.appliedDiskMb }
      : null;
    if (applied && !limitsDiffer(effective, applied)) continue; // already compliant
    const busy = await prisma.deployment.findFirst({ where: { projectId: p.id, previewId: null, status: { in: [...ACTIVE_STATUSES] } }, select: { id: true } });
    if (busy) { skipped.push({ projectId: p.id, reason: 'deployment in progress' }); continue; }
    const d = await enqueueDeployment(p.id, null, { id: current.id, imageTag: current.imageTag, commitHash: current.commitHash });
    queued.push({ projectId: p.id, deploymentId: d.id });
  }
  res.status(202).json({ queued, skipped });
});
