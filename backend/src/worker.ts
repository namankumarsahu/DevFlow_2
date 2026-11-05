import { execFile } from 'child_process';
import { randomUUID } from 'crypto';
import { mkdir, rm, writeFile } from 'fs/promises';
import path from 'path';
import { promisify } from 'util';
import { Job, Worker } from 'bullmq';
import { appUrl, config, publicScheme } from './config';
import { prisma } from './db';
import { buildctlArgs, buildctlPingArgs, checkRepoSize, childEnv, GIT_ENV, gitCloneArgs } from './lib/buildSandbox';
import { syncCaddy, syncCaddyOnStart } from './lib/caddy';
import { deploymentContainerName } from './lib/caddyConfig';
import { CleanupScope, staleNamesInScope } from './lib/containers';
import { decrypt } from './lib/crypto';
import { upsertPrComment } from './lib/github';
import { CommentState, previewComment } from './lib/previews';
import { assertSafeRunArgs } from './lib/dockerSafety';
import { assertSafeLimits, describeLimits, effectiveLimits, explainExit, limitsDiffer, OwnerRole, runLimitArgs } from './lib/limits';
import { cleanupDeployment, classifyFailure, DeployCancelled, DeployTimeout } from './lib/deployCleanup';
import { prepareBuild } from './lib/autobuild';
import { summarize } from './lib/autobuild/preflight';
import { analyzeDeployment } from './lib/autobuild/analyze';
import { validHealthPath } from './lib/autobuild/configuration';
import { runReleaseCommands } from './lib/release';
import { lookup } from 'dns/promises';
import { checkImage } from './lib/imagePolicy';
import { createLogGate } from './lib/logGate';
import { reapStaleDeployments, sweepWorkDir } from './lib/reaper';
import { runProcess } from './lib/runProcess';
import { interpretStorageProbe, publishStorageQuota } from './lib/storageQuota';
import { quotaApplies } from './services/quota';
import { dirSizeBytes } from './lib/repoSize';
import { httpProbe, waitHealthy } from './lib/health';
import { publishLog, publishStatus } from './lib/events';
import { ensureSlug } from './lib/slug';
import { QUEUE_NAME } from './queue';
import { createRedis, getRedis } from './redis';

const execFileP = promisify(execFile);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Logger = { log: (line: string) => Promise<void>; setSecrets: (values: string[]) => void };

// Persist + publish lines strictly in order (chained promises) so history == live stream.
// Output is capped (lines / bytes / line length) and known secret values are masked before anything is stored.
function makeLogger(deploymentId: string): Logger {
  let chain: Promise<void> = Promise.resolve();
  let secrets: string[] = [];
  const gate = createLogGate({
    maxLines: config.build.maxLogLines,
    maxBytes: config.build.maxLogBytes,
    maxLineChars: config.build.maxLogLineChars,
    secrets: () => secrets,
  });
  return {
    setSecrets: (values) => {
      secrets = values;
    },
    log: (text) => {
      const lines = gate(text);
      if (!lines.length) return chain;
      chain = chain.then(async () => {
        for (const line of lines) {
          await prisma.deploymentLog.create({ data: { deploymentId, line } });
          await publishLog(deploymentId, line);
        }
      });
      return chain;
    },
  };
}

async function setStatus(id: string, status: 'BUILDING' | 'DEPLOYING', extra: object = {}) {
  await prisma.deployment.update({ where: { id }, data: { status, ...extra } });
  await publishStatus(id, status);
}

// Step 14: keep ONE comment on the pull request up to date. Best effort: failures are logged, never thrown.
async function commentOnPr(project: { id: string; repoUrl: string; githubTokenEnc: string | null }, previewId: string, state: CommentState, logger?: Logger) {
  if (!project.githubTokenEnc) return;
  try {
    const preview = await prisma.preview.findUnique({ where: { id: previewId } });
    if (!preview) return;
    const dashboard = `${publicScheme}://${config.domain}/projects/${project.id}`;
    const r = await upsertPrComment({
      token: decrypt(project.githubTokenEnc),
      repoUrl: project.repoUrl,
      prNumber: preview.prNumber,
      commentId: preview.commentId,
      body: previewComment(state, dashboard),
    });
    if (r.commentId !== preview.commentId) await prisma.preview.update({ where: { id: previewId }, data: { commentId: r.commentId } });
    if (r.error) await logger?.log(`==> Could not update the pull request comment: ${r.error}`);
  } catch (e) {
    console.error('PR comment failed:', e);
  }
}

// Child processes never see the worker's secrets (DATABASE_URL, JWT_SECRET, ENCRYPTION_KEY, ...).
// Short helper commands (docker inspect/rm, git rev-parse). The timeout stops a wedged docker CLI from hanging a job.
async function capture(cmd: string, args: string[], cwd?: string) {
  const { stdout } = await execFileP(cmd, args, { cwd, maxBuffer: 10 * 1024 * 1024, env: childEnv(process.env), timeout: 60_000, killSignal: 'SIGKILL' });
  return stdout;
}

// One deployment's budget: everything (clone, build, load, start, health check) must finish before `deadline`.
type Ctx = { id: string; logger: Logger; deadline: number };
const timeLeft = (ctx: Ctx) => ctx.deadline - Date.now();
const timeoutError = () => new DeployTimeout(`Deployment timed out: a deployment may take at most ${Math.round(config.deployTimeoutMs / 1000)}s`);
function ensureTime(ctx: Ctx) {
  if (timeLeft(ctx) <= 0) throw timeoutError();
}

// Run a command, streaming stdout/stderr to the deployment log. Cancellation and the deadline kill the whole
// process group (see lib/runProcess.ts). `watchFile` caps the size of a file the command is writing.
async function run(ctx: Ctx, cmd: string, args: string[], opts: { cwd?: string; extraEnv?: Record<string, string>; watchFile?: { path: string; maxBytes: number } } = {}): Promise<void> {
  ensureTime(ctx);
  const r = await runProcess({
    cmd,
    args,
    cwd: opts.cwd,
    env: childEnv(process.env, opts.extraEnv),
    timeoutMs: Math.min(config.buildTimeoutMs, timeLeft(ctx)),
    isCancelled: async () => !!(await getRedis().get(`cancel:${ctx.id}`)),
    watchFile: opts.watchFile,
    onOutput: (t) => void ctx.logger.log(t),
  });
  if (r.outcome === 'ok') return;
  if (r.outcome === 'cancelled') throw new DeployCancelled('Cancelled');
  if (r.outcome === 'timeout') throw timeoutError();
  if (r.outcome === 'too-large') throw new Error(`The build produced an image larger than the ${config.build.maxImageMb} MB limit`);
  throw new Error(`${cmd} ${args[0]} exited with code ${r.code}`);
}

// Remove the containers DevFlow started for this project (within `scope`), except `keep` (the one now serving traffic).
// Production and previews share the project label, so production cleanup must never touch a preview and vice versa.
async function removeProjectContainers(projectId: string, keep: string | null, scope: CleanupScope = { production: true }): Promise<string[]> {
  const out = await capture('docker', ['ps', '-a', '--filter', `label=devflow.project=${projectId}`, '--format', '{{.Names}}\t{{.Label "devflow.preview"}}']);
  const names = staleNamesInScope(out, keep, scope);
  for (const n of names) await capture('docker', ['rm', '-f', n]).catch(() => undefined);
  return names;
}

// One deployment per project at a time (production), and one per preview, so a PR build never blocks production.
async function acquireLock(key: string, ttlMs = 30 * 60 * 1000) {
  const token = randomUUID();
  while (!(await getRedis().set(key, token, 'PX', ttlMs, 'NX'))) await sleep(2000);
  return async () => {
    if ((await getRedis().get(key)) === token) await getRedis().del(key);
  };
}

// Set at startup: did docker prove that it really enforces --storage-opt size=? Never trust STORAGE_QUOTA alone.
let storageQuotaVerified = false;

export async function processDeployment(deploymentId: string) {
  const dep = await prisma.deployment.findUnique({ where: { id: deploymentId }, include: { project: { include: { owner: { select: { role: true } } } }, preview: true } });
  if (!dep || dep.status !== 'QUEUED') return;
  const { project, preview } = dep;
  const ownerRole = project.owner.role as OwnerRole;
  const branch = preview ? preview.branch : project.branch;
  const logger = makeLogger(deploymentId);
  const releaseProject = await acquireLock(preview ? `lock:preview:${preview.id}` : `lock:project:${project.id}`);
  // Defence in depth for the one-build-at-a-time rule (the API already refuses a second one): builds of the same
  // user are serialised here too, so system-started redeploys or a deleted-then-recreated project cannot overlap.
  let releaseUser: () => Promise<void> = async () => undefined;
  const workDir = path.join(config.workDir, deploymentId);
  const envFile = path.join(config.workDir, `${deploymentId}.env`);
  const imageTar = path.join(config.workDir, `${deploymentId}.image.tar`); // outside workDir so it never ends up in the build context
  const startedAt = Date.now();
  const ctx: Ctx = { id: deploymentId, logger, deadline: startedAt + config.deployTimeoutMs };
  // Blue/green bookkeeping: `candidate` is the new container; it is thrown away unless traffic was switched to it.
  let candidate: string | null = null;
  let switched = false;
  let failed = true;
  let failureClass = 'clone';
  let releaseCommands = [project.releaseCommand, project.seedCommand];
  let healthPath = project.healthPath ?? config.healthPath;
  let healthMode: 'readiness' | 'liveness' = project.healthPath != null || healthPath !== '/' ? 'readiness' : 'liveness';
  const savedHealthPath = (dep.preflight as { rollbackHealthPath?: unknown } | null)?.rollbackHealthPath;
  if (dep.rollbackOfId && typeof savedHealthPath === 'string' && validHealthPath(savedHealthPath)) {
    healthPath = savedHealthPath;
    const mode = (dep.preflight as { rollbackHealthMode?: unknown } | null)?.rollbackHealthMode;
    healthMode = mode === 'readiness' || mode === 'liveness' ? mode : healthPath === '/' ? 'liveness' : 'readiness';
  }

  try {
    if (quotaApplies(ownerRole)) releaseUser = await acquireLock(`lock:user-build:${project.ownerId}`, config.deployTimeoutMs + 2 * 60 * 1000);
    // Re-check: it may have been cancelled while waiting for the lock.
    const fresh = await prisma.deployment.findUnique({ where: { id: deploymentId } });
    if (fresh?.status !== 'QUEUED') {
      failed = false;
      return;
    }
    if (preview) {
      // The pull request may have been closed while this build waited for the lock.
      const p = await prisma.preview.findUnique({ where: { id: preview.id } });
      if (p?.status !== 'ACTIVE') {
        await prisma.deployment.update({ where: { id: deploymentId }, data: { status: 'CANCELLED', finishedAt: new Date() } });
        await publishStatus(deploymentId, 'CANCELLED');
        failed = false;
        return;
      }
    }
    await mkdir(config.workDir, { recursive: true });
    await setStatus(deploymentId, 'BUILDING', { startedAt: new Date() });
    if (preview) await logger.log(`==> Preview for pull request #${preview.prNumber} (branch ${preview.branch})`);
    await logger.log(`==> Time budget: ${Math.round(config.deployTimeoutMs / 1000)}s for the whole deployment`);

    // Set redaction before rendering/logging generated Dockerfiles or building.
    const vars = await prisma.envVar.findMany({ where: { projectId: project.id } });
    const decrypted = vars.map((v: { key: string; valueEnc: string }) => ({ key: v.key, value: decrypt(v.valueEnc) }));
    logger.setSecrets([...decrypted.map((v: { value: string }) => v.value), ...(project.githubTokenEnc ? [decrypt(project.githubTokenEnc)] : [])]);
    let imageTag = dep.imageTag;
    if (dep.rollbackOfId && imageTag) {
      const rollbackReport = summarize([{ id: 'rollback.image', severity: 'info' as const, message: 'Rollback reuses an existing image; repository inspection and release commands are skipped.', evidence: [{ file: '<image>', line: 1 }], fix: 'Use backward-compatible migrations and verify current environment requirements.' }], dep.detectedStack ?? 'Dockerfile', 'rollback');
      await prisma.deployment.update({ where: { id: deploymentId }, data: { preflight: JSON.parse(JSON.stringify({ ...rollbackReport, rollbackHealthPath: healthPath, rollbackHealthMode: healthMode })) } });
      await logger.log(`==> Rollback: reusing image ${imageTag}`);
      await capture('docker', ['image', 'inspect', imageTag]).catch(() => {
        throw new Error('Image for the target deployment no longer exists (pruned?)');
      });
    } else {
      await logger.log(`==> Cloning ${project.repoUrl} (${branch})`);
      await run(ctx, 'git', gitCloneArgs(branch, project.repoUrl, workDir), { extraEnv: GIT_ENV });
      const tooBig = checkRepoSize(await dirSizeBytes(workDir, config.maxRepoMb * 1024 * 1024), config.maxRepoMb);
      if (tooBig) throw new Error(tooBig);
      failureClass = 'preflight';
      const commit = (await capture('git', ['rev-parse', 'HEAD'], workDir)).trim();
      const analysis = await analyzeDeployment(workDir, project, decrypted.map((v: { key: string }) => v.key), { port: project.containerPort, healthPath: config.healthPath, limits: effectiveLimits(project, ownerRole, config.maxLimits, config.defaultLimits) }, config.build.maxDockerfileKb * 1024, commit);
      const requirements = analysis.report;
      if (analysis.resolved) releaseCommands = [analysis.resolved.settings.releaseCommand ?? null, analysis.resolved.settings.seedCommand ?? null];
      if (analysis.resolved) healthPath = analysis.resolved.plan.healthPath;
      if (analysis.resolved) healthMode = analysis.resolved.plan.healthMode;
      const reviewedPlanId = (dep.preflight as { reviewedPlanId?: string } | null)?.reviewedPlanId;
      await prisma.deployment.update({ where: { id: deploymentId }, data: { preflight: JSON.parse(JSON.stringify({ ...requirements, ...(reviewedPlanId ? { reviewedPlanId } : {}) })), detectedStack: requirements.stack, buildRule: requirements.rule } });
      if (reviewedPlanId && requirements.plan?.id !== reviewedPlanId) throw new Error('The repository revision, settings or effective policy changed after plan review. Run Requirements again before deploying.');
      if (requirements.plan) await logger.log(`==> Deployment plan v${requirements.plan.version}: ${requirements.plan.id} (${requirements.plan.scope}; ${requirements.plan.healthMode})`);
      await logger.log(`==> Requirements: ${requirements.status} — ${requirements.reason}`);
      for (const finding of requirements.findings) await logger.log(`==> ${finding.severity.toUpperCase()} ${finding.id}: ${finding.message} Fix: ${finding.fix}`);
      const actor = dep.preflightOverride && dep.triggeredById ? await prisma.user.findUnique({ where: { id: dep.triggeredById }, select: { role: true } }) : null;
      if (requirements.findings.some((f) => f.severity === 'blocker') && actor?.role !== 'ADMIN') {
        if (!requirements.stack && requirements.rule === 'auto-detect') throw new Error('Could not auto-detect this repository. Supported stacks: static sites, Node, Django, Flask, FastAPI and fullstack. Pick a preset in project settings or add a Dockerfile.');
        if (project.buildMode === 'DOCKERFILE' && requirements.findings.some((f) => f.id === 'layout.dockerfile')) throw new Error('Dockerfile rejected: No Dockerfile found at the repository root');
        throw new Error('Requirements blocked: ' + requirements.findings.filter((f) => f.severity === 'blocker').map((f) => f.message).join('; '));
      }
      if (actor?.role === 'ADMIN') await logger.log('==> Admin explicitly overrode requirements blockers; sandbox, quotas and runtime caps are unchanged');
      const plan = await prepareBuild(workDir, project, { port: project.containerPort, limits: effectiveLimits(project, ownerRole, config.maxLimits, config.defaultLimits) }, config.build.maxDockerfileKb * 1024, logger.log, async (meta) => {
        await prisma.deployment.update({ where: { id: deploymentId }, data: { buildRule: meta.rule, detectedStack: meta.stack ?? null } });
      }, analysis.resolved);
      failureClass = 'build';
      imageTag = `devflow/${project.id}:${commit.slice(0, 12)}-${deploymentId.slice(0, 8)}`;
      await prisma.deployment.update({ where: { id: deploymentId }, data: { commitHash: commit, imageTag } });
      if (preview) {
        await prisma.preview.update({ where: { id: preview.id }, data: { headSha: commit } });
        await commentOnPr(project, preview.id, { state: 'building', sha: commit }, logger);
      }
      await logger.log(`==> Building image ${imageTag} @ ${commit.slice(0, 7)} (${config.buildSandbox === 'buildkit' ? 'sandboxed rootless BuildKit' : 'host Docker daemon, NOT sandboxed'})`);
      if (config.buildSandbox === 'buildkit') {
        // Untrusted Dockerfile steps run inside the rootless BuildKit container, not on the host daemon.
        await run(ctx, 'buildctl', buildctlPingArgs(config.buildkitAddr)).catch((e) => {
          if (e instanceof DeployCancelled || e instanceof DeployTimeout) throw e;
          throw new Error(`Build sandbox unreachable at ${config.buildkitAddr}. Is the "buildkit" service running? (Set BUILD_SANDBOX=docker to fall back, unsafe for untrusted code.)`);
        });
        await run(ctx, 'buildctl', buildctlArgs({ addr: config.buildkitAddr, contextDir: plan.contextDir ?? workDir, dockerfileDir: plan.dockerfileDir, imageTag, tarPath: imageTar }), {
          // The export is written on the worker's disk while the build runs: stop it if it outgrows the image limit.
          watchFile: { path: imageTar, maxBytes: config.build.maxImageMb * 1024 * 1024 },
        });
        await logger.log('==> Loading built image into the app runtime');
        await run(ctx, 'docker', ['load', '-i', imageTar]);
        await rm(imageTar, { force: true });
      } else {
        await run(ctx, 'docker', ['build', ...(plan.generated ? ['--secret', 'id=devflow_ca,src=/etc/ssl/certs/ca-certificates.crt', '-f', path.join(plan.dockerfileDir, 'Dockerfile')] : []), '-t', imageTag, plan.contextDir ?? workDir]);
      }
    }

    // Reject oversized images and (in demo mode) images that declare VOLUMEs, which would bypass the disk limits.
    failureClass = 'image-policy';
    const inspected = await capture('docker', ['image', 'inspect', imageTag!, '--format', '{{json .}}']).catch(() => '');
    const imageProblem = checkImage(inspected, { maxImageMb: config.build.maxImageMb, rejectVolumes: config.demo.enabled && ownerRole !== 'ADMIN' });
    if (imageProblem) {
      await capture('docker', ['rmi', '-f', imageTag!]).catch(() => undefined);
      throw new Error(imageProblem);
    }
    ensureTime(ctx);

    await setStatus(deploymentId, 'DEPLOYING');
    // Mask env values (and the PR-comment token) if the app or the build ever prints them.
    const lines = [`PORT=${project.containerPort}`, `NODE_ENV=${project.environment.toLowerCase()}`];
    if (preview) lines.push('DEVFLOW_PREVIEW=1', `DEVFLOW_URL=${appUrl(preview.slug)}`, `DEVFLOW_PR_NUMBER=${preview.prNumber}`);
    decrypted.forEach((v: { key: string; value: string }) => lines.push(`${v.key}=${v.value}`));
    lines.push(`PORT=${project.containerPort}`); // The reviewed project port owns the public listener.
    lines.push(`DEVFLOW_URL=${preview ? appUrl(preview.slug) : appUrl(project.slug ?? (await ensureSlug(project.id, project.name)))}`);
    // Trust the Caddy service and loopback only, never arbitrary forwarded headers.
    const proxies = await lookup('caddy', { all: true }).catch(() => []);
    lines.push(`DEVFLOW_TRUSTED_PROXIES=${['127.0.0.1', '::1', ...proxies.map((p) => p.address)].join(',')}`);
    // env-file (mode 0600, deleted afterwards) keeps secrets out of `ps` output and logs.
    await writeFile(envFile, lines.join('\n') + '\n', { mode: 0o600 });

    const newName = deploymentContainerName(project.id, deploymentId);
    const before = await prisma.project.findUnique({ where: { id: project.id }, select: { currentDeploymentId: true } });
    const previousDeploymentId = (preview ? (await prisma.preview.findUnique({ where: { id: preview.id }, select: { currentDeploymentId: true } }))?.currentDeploymentId : before?.currentDeploymentId) ?? null;

    // The stored per-project values are only a request. What the container gets is decided here, on the server.
    const requested = { memoryMb: project.memoryMb, cpus: project.cpus, diskMb: project.diskMb };
    const limits = effectiveLimits(requested, ownerRole, config.maxLimits, config.defaultLimits);
    assertSafeLimits(limits);
    const policy = { ...config.runtime, storageQuota: storageQuotaVerified };

    if (!dep.rollbackOfId) {
      failureClass = 'release';
      await runReleaseCommands(releaseCommands, {
        deploymentId, image: imageTag!, network: config.appsNetwork, envFile, limits: runLimitArgs(limits, policy),
        run: (args) => run(ctx, 'docker', args), remove: async (name) => { await capture('docker', ['rm', '-f', name]); }, log: logger.log,
      });
    }
    failureClass = 'health';

    // 1. Start the NEW version next to the old one (different container name). Old keeps serving.
    await logger.log(`==> Starting new container ${newName}${previousDeploymentId ? ' (previous version keeps serving)' : ''}`);
    await logger.log(`==> Resource limits: ${describeLimits(limits, policy)}`);
    if (limitsDiffer(limits, requested)) {
      await logger.log(`==> Note: the project asks for ${requested.memoryMb} MB / ${requested.cpus} CPU / ${requested.diskMb} MB disk; the server maximum for this account applies`);
    }
    await capture('docker', ['rm', '-f', newName]).catch(() => undefined); // leftover from a retried job
    candidate = newName;
    const runArgs = [
      'run', '-d', '--name', newName, '--restart', 'unless-stopped',
      // No published host port: the app is only reachable through Caddy on the apps network.
      '--network', config.appsNetwork,
      '--env-file', envFile,
      ...runLimitArgs(limits, policy),
      '--label', `devflow.project=${project.id}`,
      '--label', `devflow.deployment=${deploymentId}`,
      ...(preview ? ['--label', `devflow.preview=${preview.id}`] : []),
      imageTag!,
    ];
    // Nothing user-controlled may add privileged flags, host mounts, the Docker socket, host networking...
    assertSafeRunArgs(runArgs, { network: config.appsNetwork, envFile });
    await run(ctx, 'docker', runArgs);

    // 2. Wait until it really answers HTTP. If it never does, the old version is untouched.
    const healthBudget = Math.min(config.healthTimeoutMs, Math.max(1000, timeLeft(ctx)));
    await logger.log(`==> Health check: GET ${healthPath} on port ${project.containerPort} (up to ${Math.round(healthBudget / 1000)}s)`);
    let lastLogged = 0;
    const health = await waitHealthy({
      probe: () => httpProbe(newName, project.containerPort, healthPath),
      acceptStatus: status => healthMode === 'readiness' ? status >= 200 && status < 300 : status < 500,
      isAlive: async () => (await capture('docker', ['inspect', '-f', '{{.State.Running}}', newName]).catch(() => 'false')).trim() === 'true',
      shouldAbort: async () => !!(await getRedis().get(`cancel:${deploymentId}`)),
      timeoutMs: healthBudget,
      onAttempt: (n, status, elapsed) => {
        if (status === null && elapsed - lastLogged >= 10_000) {
          lastLogged = elapsed;
          void logger.log(`    ...still waiting for the app to accept connections (${Math.round(elapsed / 1000)}s)`);
        }
      },
    });
    if (!health.ok) {
      if (health.reason === 'cancelled') throw new DeployCancelled('Cancelled');
      const tail = await capture('docker', ['logs', '--tail', '40', newName]).catch(() => '');
      if (tail) await logger.log(tail);
      const exitInfo = await capture('docker', ['inspect', '-f', '{{.State.OOMKilled}} {{.State.ExitCode}}', newName]).catch(() => '');
      const why =
        health.reason === 'exited'
          ? `the container exited${explainExit(exitInfo, limits.memoryMb) ? `: ${explainExit(exitInfo, limits.memoryMb)}` : ''}`
          : health.lastStatus === null
            ? `nothing answered on port ${project.containerPort} within ${Math.round(healthBudget / 1000)}s (is the app listening on $PORT?)`
            : `it kept returning HTTP ${health.lastStatus} on ${healthPath}`;
      if (health.reason === 'timeout' && timeLeft(ctx) <= 0) throw timeoutError();
      throw new Error(`New version failed its health check: ${why}.${previousDeploymentId ? ' The previous version is still serving traffic.' : ''}`);
    }
    await logger.log(`==> Healthy after ${health.attempts} check(s)`);

    // 3. Switch traffic. Caddy reloads gracefully: requests already in flight finish on the old container.
    const url = preview ? appUrl(preview.slug) : appUrl(project.slug ?? (await ensureSlug(project.id, project.name)));
    if (preview) {
      // Closed while we were building? Do not bring a dead preview back to life.
      const p = await prisma.preview.findUnique({ where: { id: preview.id }, select: { status: true } });
      if (p?.status !== 'ACTIVE') throw new DeployCancelled('Cancelled');
    }
    // Record what this container really runs with, so the dashboard can tell when a redeploy is needed.
    await prisma.deployment.update({
      where: { id: deploymentId },
      data: { containerName: newName, url, appliedMemoryMb: limits.memoryMb, appliedCpus: limits.cpus, appliedDiskMb: limits.diskMb },
    });
    const setCurrent = (id: string | null) =>
      preview
        ? prisma.preview.update({ where: { id: preview.id }, data: { currentDeploymentId: id } })
        : prisma.project.update({ where: { id: project.id }, data: { currentDeploymentId: id } });
    failureClass = 'routing';
    await setCurrent(deploymentId);
    try {
      await syncCaddy();
    } catch (e) {
      // Could not tell Caddy: put the database back so it still describes what is actually serving.
      await setCurrent(previousDeploymentId);
      throw e;
    }
    switched = true;
    failed = false;
    await prisma.deployment.update({
      where: { id: deploymentId },
      data: { status: 'SUCCESS', failureClass: null, finishedAt: new Date(), durationMs: Date.now() - startedAt },
    });
    await logger.log(`==> Live at ${url}`);
    await publishStatus(deploymentId, 'SUCCESS');
    if (preview) await commentOnPr(project, preview.id, { state: 'ready', sha: dep.commitHash ?? preview.headSha ?? '', url }, logger);

    // 4. Drain, then retire the old version. A failure here must not turn a successful deploy into a failed one.
    try {
      if (previousDeploymentId) await sleep(config.drainMs);
      const removed = await removeProjectContainers(project.id, newName, preview ? { previewId: preview.id } : { production: true });
      if (removed.length) await logger.log(`==> Stopped previous version (${removed.join(', ')})`);
    } catch (e) {
      console.error('Cleanup of old containers failed:', e);
    }
  } catch (err) {
    const reason = classifyFailure(err);
    const message = err instanceof Error ? err.message : String(err);
    // Remove the half-started container NOW, before the status flips, so a timed-out / cancelled / failed attempt
    // never leaves something running that no quota counts.
    if (candidate && !switched && (await capture('docker', ['rm', '-f', candidate]).then(() => true, () => false))) candidate = null; // else the finally block retries
    await logger.log(reason === 'cancelled' ? '==> Deployment cancelled' : reason === 'timeout' ? `==> TIMED OUT: ${message}` : `==> FAILED: ${message}`);
    const status = reason === 'cancelled' ? 'CANCELLED' : 'FAILED';
    await prisma.deployment.update({
      where: { id: deploymentId },
      data: { status, failureClass: reason === 'failed' ? failureClass : reason, error: reason === 'cancelled' ? null : message, finishedAt: new Date(), durationMs: Date.now() - startedAt },
    });
    await publishStatus(deploymentId, status);
    if (preview && reason !== 'cancelled') {
      const sha = (await prisma.preview.findUnique({ where: { id: preview.id }, select: { headSha: true } }))?.headSha ?? '';
      await commentOnPr(project, preview.id, { state: 'failed', sha, error: message });
    }
  } finally {
    for (const index of [0, 1]) if (!dep.rollbackOfId && (index === 0 ? project.releaseCommand : project.seedCommand)) await capture('docker', ['rm', '-f', `devflow-release-${deploymentId}-${index}`]).catch(() => undefined);
    // Temp files (clone, secrets env-file, image tarball), a leftover candidate container and the cancel flag.
    const problems = await cleanupDeployment(
      { candidateContainer: candidate, switched, paths: [workDir, envFile, imageTar], failed },
      {
        removeContainer: async (n) => void (await capture('docker', ['rm', '-f', n])),
        removePath: (p) => rm(p, { recursive: true, force: true }),
        clearCancelFlag: async () => void (await getRedis().del(`cancel:${deploymentId}`)),
      },
    );
    if (problems.length) console.error(`Cleanup problems for ${deploymentId}:`, problems);
    await releaseUser();
    await releaseProject();
  }
}

// Step 14: a pull request was closed. Wait for any in-flight build of that preview, then remove its containers.
async function teardownPreview(previewId: string) {
  const first = await prisma.preview.findUnique({ where: { id: previewId }, include: { project: true } });
  if (!first) return;
  const release = await acquireLock(`lock:preview:${previewId}`);
  try {
    // Re-read: the PR may have been reopened while we waited (then a new deployment owns the preview again).
    const preview = await prisma.preview.findUnique({ where: { id: previewId } });
    if (!preview || preview.status !== 'CLOSED') return;
    await removeProjectContainers(first.projectId, null, { previewId }).catch(() => undefined);
    await prisma.preview.update({ where: { id: previewId }, data: { currentDeploymentId: null } });
    await syncCaddy().catch((e) => console.error('Caddy sync failed:', e));
    await commentOnPr(first.project, previewId, { state: 'closed' });
  } finally {
    await release();
  }
}

const worker = new Worker(
  QUEUE_NAME,
  async (job: Job) => {
    if (job.name === 'preview-teardown') {
      await teardownPreview(job.data.previewId);
      return;
    }
    if (job.name === 'teardown') {
      await removeProjectContainers(job.data.projectId, null, 'all').catch(() => undefined);
      await syncCaddy().catch((e) => console.error('Caddy sync failed:', e));
      return;
    }
    await processDeployment(job.data.deploymentId);
  },
  { connection: createRedis(), concurrency: 2 },
);

worker.on('failed', (job, err) => console.error(`Job ${job?.id} failed:`, err));
console.log('DevFlow worker started');
if (config.isProd && config.buildSandbox !== 'buildkit') {
  console.warn('WARNING: BUILD_SANDBOX=docker. Untrusted Dockerfiles run on the host Docker daemon. Use BUILD_SANDBOX=buildkit.');
}
void syncCaddyOnStart();

// Housekeeping: fail deployments whose worker disappeared, and sweep temp files from builds that died uncleanly.
const removeContainerQuietly = async (name: string) => void (await capture('docker', ['rm', '-f', name]));
const housekeeping = () =>
  reapStaleDeployments({ removeContainer: removeContainerQuietly })
    .then((ids) => ids.length && console.warn(`Reaped ${ids.length} stale deployment(s)`))
    .then(() => sweepWorkDir())
    .catch((e) => console.error('Housekeeping failed:', e));
void housekeeping();
setInterval(housekeeping, 60_000).unref();

// Disk quotas are only advertised after docker proved it can enforce them (see lib/storageQuota.ts).
async function verifyStorageQuota() {
  if (!config.runtime.storageQuota) return;
  try {
    await execFileP('docker', ['run', '--rm', '--network', 'none', '--storage-opt', 'size=16m', 'hello-world'], { timeout: 120_000, env: childEnv(process.env) });
    storageQuotaVerified = interpretStorageProbe(0, '');
  } catch (e: any) {
    storageQuotaVerified = interpretStorageProbe(typeof e?.code === 'number' ? e.code : 1, String(e?.stderr ?? e?.message ?? ''));
  }
  if (!storageQuotaVerified) console.warn('STORAGE_QUOTA=true, but docker could not enforce --storage-opt on this host. Disk quotas stay OFF and the dashboard will say so.');
}
void verifyStorageQuota().then(async () => {
  const publish = () => publishStorageQuota(storageQuotaVerified).catch(() => undefined);
  await publish();
  setInterval(publish, 60_000).unref();
});

const shutdown = async () => {
  await worker.close();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
