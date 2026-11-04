import crypto from 'crypto';
import { Request, Router } from 'express';
import { z } from 'zod';
import { appUrl, config } from '../config';
import { prisma } from '../db';
import { encrypt } from '../lib/crypto';
import { HttpError } from '../lib/errors';
import { effectiveLimits, limitsDiffer, limitsExceeded, OwnerRole, ResourceLimits } from '../lib/limits';
import { makeSlug } from '../lib/slug';
import { storageQuotaEnforced } from '../lib/storageQuota';
import { closePreviewById } from '../services/previews';
import { authenticate } from '../middleware/auth';
import { enqueueTeardown, requestDeployment } from '../services/deployments';
import { ACTIVE_STATUSES, getUsage, quotaApplies, withUserLock } from '../services/quota';
import { deployBurstLimiter } from '../middleware/limiters';
import { validCommand } from '../lib/autobuild/render';

export const projectsRouter = Router();
projectsRouter.use(authenticate);

export async function getAccessibleProject(req: Request, id: string) {
  const p = await prisma.project.findUnique({ where: { id } });
  if (!p || (p.ownerId !== req.user!.id && req.user!.role !== 'ADMIN')) throw new HttpError(404, 'Project not found');
  return p;
}

// Never send the encrypted GitHub token to the browser; only whether one is set.
export function publicProject<T extends { githubTokenEnc?: string | null }>(p: T) {
  const { githubTokenEnc, ...rest } = p;
  return { ...rest, hasGithubToken: !!githubTokenEnc };
}

// Strict allow-lists: values end up in `git clone`, so no flags / local paths / other hosts.
const commandSchema = z.string().min(1).max(1000).refine((v) => validCommand(v) && !!v.trim(), 'Commands cannot contain newlines or control characters').nullable();
const projectSchema = z.object({
  name: z.string().min(1).max(60),
  repoUrl: z.string().regex(/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/, 'Must be https://github.com/<owner>/<repo>'),
  branch: z.string().regex(/^[\w][\w./-]*$/).max(100).default('main'),
  environment: z.enum(['DEVELOPMENT', 'STAGING', 'PRODUCTION']).default('PRODUCTION'),
  containerPort: z.number().int().min(1).max(65535).default(3000),
  buildMode: z.enum(['AUTO', 'DOCKERFILE']).default('AUTO'),
  preset: z.enum(['STATIC', 'NODE', 'PYTHON_DJANGO', 'PYTHON_FLASK', 'PYTHON_FASTAPI', 'FULLSTACK']).nullable().default(null),
  startCommand: commandSchema.default(null),
  buildCommand: commandSchema.default(null),
  // Step 7: resource limits. Upper bounds for non-admins are checked in assertWithinLimits().
  memoryMb: z.number().int().min(64).max(1_048_576).default(config.defaultLimits.memoryMb),
  cpus: z.number().min(0.1).max(64).default(config.defaultLimits.cpus),
  diskMb: z.number().int().min(128).max(10_485_760).default(config.defaultLimits.diskMb),
  previewsEnabled: z.boolean().default(false), // Step 14
});

// Requested (stored) vs effective (what the next deploy will really use) vs applied (what the live container has).
async function limitsView(p: { id: string; ownerId: string; memoryMb: number; cpus: number; diskMb: number; currentDeploymentId: string | null }) {
  const [owner, current] = await Promise.all([
    prisma.user.findUnique({ where: { id: p.ownerId }, select: { role: true } }),
    p.currentDeploymentId
      ? prisma.deployment.findUnique({ where: { id: p.currentDeploymentId }, select: { appliedMemoryMb: true, appliedCpus: true, appliedDiskMb: true } })
      : Promise.resolve(null),
  ]);
  const role = (owner?.role ?? 'USER') as OwnerRole;
  const requested: ResourceLimits = { memoryMb: p.memoryMb, cpus: p.cpus, diskMb: p.diskMb };
  const effective = effectiveLimits(requested, role, config.maxLimits, config.defaultLimits);
  const applied: ResourceLimits | null =
    current && current.appliedMemoryMb != null && current.appliedCpus != null && current.appliedDiskMb != null
      ? { memoryMb: current.appliedMemoryMb, cpus: current.appliedCpus, diskMb: current.appliedDiskMb }
      : null;
  // Unknown limits on a live container (deployed before this was recorded) count as "needs redeploy" in demo mode,
  // because that container may predate the demo limits.
  const needsRedeploy = !!p.currentDeploymentId && (applied ? limitsDiffer(effective, applied) : config.demo.enabled && role !== 'ADMIN');
  return { requested, effective, applied, needsRedeploy, diskEnforced: await storageQuotaEnforced() };
}

async function withLimits<T extends { id: string; ownerId: string; memoryMb: number; cpus: number; diskMb: number; currentDeploymentId: string | null; githubTokenEnc?: string | null }>(p: T) {
  return { ...publicProject(p), limits: await limitsView(p) };
}

function assertWithinLimits(req: Request, data: { memoryMb?: number; cpus?: number; diskMb?: number }) {
  if (req.user!.role === 'ADMIN') return; // admins may go above the per-app maximum
  const problem = limitsExceeded(data, config.maxLimits);
  if (problem) throw new HttpError(400, `Resource limit too high: ${problem}`);
}

// What the dashboard needs to render the limits form.
projectsRouter.get('/limits', async (req, res) => {
  const demo = config.demo;
  res.json({
    defaults: config.defaultLimits,
    max: config.maxLimits,
    // True only when the worker has proven that docker really enforces disk quotas on this host.
    diskQuotaEnforced: await storageQuotaEnforced(),
    adminsExceedMax: req.user!.role === 'ADMIN',
    demo: {
      enabled: demo.enabled,
      maxActiveApps: demo.maxActiveApps,
      maxProjects: demo.maxProjects,
      maxDeploysPerHour: demo.maxDeploysPerHour,
      maxConcurrentBuilds: 1,
      deployTimeoutSeconds: Math.round(config.deployTimeoutMs / 1000),
      previewsAllowed: !demo.enabled,
    },
  });
});

// The caller's own usage: active apps vs. deployment attempts vs. failures (kept separate on purpose).
projectsRouter.get('/usage', async (req, res) => {
  res.json(await getUsage(req.user!.id, req.user!.role as OwnerRole));
});

function assertPreviewsAllowed(req: Request, previewsEnabled?: boolean) {
  // Every preview is one more running container per project, which would break the per-user app quota.
  if (previewsEnabled && quotaApplies(req.user!.role as OwnerRole)) {
    throw new HttpError(403, 'Pull-request previews are disabled in demo mode', { code: 'PREVIEWS_DISABLED' });
  }
}

projectsRouter.post('/', async (req, res) => {
  const data = projectSchema.parse(req.body);
  assertWithinLimits(req, data);
  assertPreviewsAllowed(req, data.previewsEnabled);
  const ownerId = req.user!.id;
  const make = async (db: Pick<typeof prisma, 'project'>) => {
    const agg = await db.project.aggregate({ _max: { hostPort: true } });
    return db.project.create({
      data: {
        ...data,
        ownerId,
        hostPort: (agg._max.hostPort ?? 19999) + 1, // legacy column, no longer published
        slug: makeSlug(data.name),
        webhookSecret: crypto.randomBytes(24).toString('hex'),
      },
    });
  };
  let project;
  if (!quotaApplies(req.user!.role as OwnerRole)) {
    project = await make(prisma);
  } else {
    // Cap on created projects (active or not), counted under the same per-user lock as the deployment quota.
    for (let attempt = 0; ; attempt++) {
      try {
        project = await withUserLock(ownerId, async (tx) => {
          if ((await tx.project.count({ where: { ownerId } })) >= config.demo.maxProjects) {
            throw new HttpError(403, `Demo limit reached: at most ${config.demo.maxProjects} projects per account. Delete one you no longer need.`, { code: 'PROJECT_LIMIT_REACHED' });
          }
          return make(tx);
        });
        break;
      } catch (e: any) {
        if (e?.code === 'P2002' && attempt < 2) continue; // legacy hostPort / slug clash with a concurrent create
        throw e;
      }
    }
  }
  res.status(201).json(await withLimits(project));
});

projectsRouter.get('/', async (req, res) => {
  const where = req.user!.role === 'ADMIN' ? {} : { ownerId: req.user!.id };
  res.json((await prisma.project.findMany({ where, orderBy: { createdAt: 'desc' } })).map(publicProject));
});

projectsRouter.get('/:id', async (req, res) => {
  res.json(await withLimits(await getAccessibleProject(req, req.params.id)));
});

projectsRouter.patch('/:id', async (req, res) => {
  await getAccessibleProject(req, req.params.id);
  const data = projectSchema.partial().omit({ repoUrl: true }).parse(req.body);
  assertWithinLimits(req, data);
  assertPreviewsAllowed(req, data.previewsEnabled);
  res.json(await withLimits(await prisma.project.update({ where: { id: req.params.id }, data })));
});

projectsRouter.delete('/:id', async (req, res) => {
  const p = await getAccessibleProject(req, req.params.id);
  if (quotaApplies(req.user!.role as OwnerRole)) {
    // Deleting a project erases its deployment rows. Doing that mid-build would hide a running build from the
    // one-build-at-a-time rule, so the build has to be cancelled (or finish) first.
    const busy = await prisma.deployment.findFirst({
      where: { projectId: p.id, previewId: null, status: { in: [...ACTIVE_STATUSES] }, createdAt: { gte: new Date(Date.now() - config.demo.staleAfterMs) } },
      select: { id: true },
    });
    if (busy) throw new HttpError(409, 'A deployment is still running for this project. Cancel it first, then delete the project.', { code: 'BUILD_IN_PROGRESS', data: { deploymentId: busy.id } });
  }
  await prisma.project.delete({ where: { id: p.id } });
  await enqueueTeardown(p.id); // worker removes the running container
  res.status(204).end();
});

projectsRouter.post('/:id/deploy', deployBurstLimiter, async (req, res) => {
  const p = await getAccessibleProject(req, String(req.params.id));
  res.status(202).json(await requestDeployment(p, req.user!.id));
});

projectsRouter.get('/:id/deployments', async (req, res) => {
  const p = await getAccessibleProject(req, req.params.id);
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  res.json(await prisma.deployment.findMany({ where: { projectId: p.id, previewId: null }, orderBy: { createdAt: 'desc' }, take: limit }));
});

// ---- Environment variables (encrypted at rest, values never returned) ----
const envSchema = z.object({
  key: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).max(100),
  value: z.string().max(4096).refine((v) => !/[\r\n]/.test(v), 'Newlines are not allowed'),
});

projectsRouter.get('/:id/env', async (req, res) => {
  const p = await getAccessibleProject(req, req.params.id);
  const vars = await prisma.envVar.findMany({ where: { projectId: p.id }, orderBy: { key: 'asc' } });
  res.json(vars.map((v) => ({ key: v.key, updatedAt: v.updatedAt })));
});

projectsRouter.put('/:id/env', async (req, res) => {
  const p = await getAccessibleProject(req, req.params.id);
  const { key, value } = envSchema.parse(req.body);
  if (quotaApplies(req.user!.role as OwnerRole)) {
    const existing = await prisma.envVar.findMany({ where: { projectId: p.id }, select: { key: true } });
    if (!existing.some((v: { key: string }) => v.key === key) && existing.length >= config.demo.maxEnvVars) {
      throw new HttpError(403, `Demo limit reached: at most ${config.demo.maxEnvVars} environment variables per project`, { code: 'ENV_VAR_LIMIT_REACHED' });
    }
  }
  const valueEnc = encrypt(value);
  await prisma.envVar.upsert({
    where: { projectId_key: { projectId: p.id, key } },
    create: { projectId: p.id, key, valueEnc },
    update: { valueEnc },
  });
  res.json({ key });
});

projectsRouter.delete('/:id/env/:key', async (req, res) => {
  const p = await getAccessibleProject(req, req.params.id);
  await prisma.envVar.deleteMany({ where: { projectId: p.id, key: req.params.key } });
  res.status(204).end();
});

// ---- Step 14: preview deployments (one per open pull request) ----
projectsRouter.get('/:id/previews', async (req, res) => {
  const p = await getAccessibleProject(req, req.params.id);
  const previews = await prisma.preview.findMany({
    where: { projectId: p.id },
    orderBy: { updatedAt: 'desc' },
    take: 50,
    include: { deployments: { orderBy: { createdAt: 'desc' }, take: 1, select: { id: true, status: true, url: true, error: true, commitHash: true } } },
  });
  res.json(
    previews.map(({ deployments, commentId, ...pv }) => ({
      ...pv,
      latest: deployments[0] ?? null,
      url: pv.currentDeploymentId ? appUrl(pv.slug) : null, // only a preview that is actually live has a URL
    })),
  );
});

// Manually shut a preview down (the PR closing does this automatically).
projectsRouter.delete('/:id/previews/:previewId', async (req, res) => {
  const p = await getAccessibleProject(req, req.params.id);
  const preview = await prisma.preview.findUnique({ where: { id: req.params.previewId } });
  if (!preview || preview.projectId !== p.id) throw new HttpError(404, 'Preview not found');
  if (preview.status === 'ACTIVE') await closePreviewById(preview.id);
  res.status(204).end();
});

// Token used ONLY to post the preview link on pull requests (fine-grained PAT: "Pull requests: Read and write").
const tokenSchema = z.object({ token: z.string().min(20).max(255).regex(/^[\w-]+$/, 'Not a valid GitHub token') });

projectsRouter.put('/:id/github-token', async (req, res) => {
  const p = await getAccessibleProject(req, req.params.id);
  const { token } = tokenSchema.parse(req.body);
  await prisma.project.update({ where: { id: p.id }, data: { githubTokenEnc: encrypt(token) } });
  res.json({ hasGithubToken: true });
});

projectsRouter.delete('/:id/github-token', async (req, res) => {
  const p = await getAccessibleProject(req, req.params.id);
  await prisma.project.update({ where: { id: p.id }, data: { githubTokenEnc: null } });
  res.status(204).end();
});
