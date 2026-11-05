import { createHash } from 'crypto';
import { appRoot, normalizeRootDir } from './root';
import { entry, file } from './files';
import { detect, detectPreset } from './selection';
import { render, nodeBuild, nodeStart, nodeInstallCommand, pythonStart, pythonInstallCommand } from './render';
import { lintDockerfile } from '../dockerfileLint';
import { AppSpec, BuildSettings, Detection, RenderContext } from './types';
import { SUPPORT_VERSION } from './support';
import type { ConfigSource } from './configuration';

export const PLAN_VERSION = 1;
export type PlanSettings = BuildSettings & { releaseCommand?: string | null; seedCommand?: string | null };
export type DeploymentPlan = {
  version: number; id: string; revision: string | null; root: string; rule: string; stack: string;
  configuration: ConfigSource | null;
  scope: 'static-assets' | 'web-service' | 'cohosted-frontend-api' | 'dockerfile';
  confidence: 'manifest-and-entrypoint' | 'user-dockerfile'; evidence: string[];
  port: number; healthPath: string; healthMode: 'readiness' | 'liveness'; limits: RenderContext['limits'];
  releaseCommand: string | null; seedCommand: string | null; requiredEnv: string[];
  externalRequirements: { kind: string; evidence: { file: string; line: number }[]; state: 'configuration-unverified' }[];
  components: { root: string; framework: string; runtime: string; manager: string | null; install: string | null; build: string | null; start: string; output: string | null; port: number }[];
  verification: 'HTTP checks only; application workflows and external credentials are unverified';
};
export type ResolvedPlan = { plan: DeploymentPlan; settings: PlanSettings; contextDir: string; text: string; generated: boolean; warning?: string; detection?: Detection };
const hash = (text: string) => createHash('sha256').update(text).digest('hex');

// Read Git metadata only, without running Git hooks or application code.
export async function repositoryRevision(repo: string): Promise<string | null> {
  const head = (await file(repo, '.git/HEAD'))?.trim();
  if (!head) return null;
  if (/^[a-f0-9]{40,64}$/.test(head)) return head;
  const ref = /^ref: (refs\/[\w./-]+)$/.exec(head)?.[1];
  if (!ref || ref.split('/').includes('..')) return null;
  const direct = (await file(repo, `.git/${ref}`))?.trim();
  if (direct && /^[a-f0-9]{40,64}$/.test(direct)) return direct;
  const packed = await file(repo, '.git/packed-refs');
  return packed?.split('\n').map(line => line.split(' ')).find(parts => parts[1]?.trim() === ref && /^[a-f0-9]{40,64}$/.test(parts[0]))?.[0] ?? null;
}

export async function resolvePlan(clone: string, settings: PlanSettings, ctx: RenderContext, maxBytes: number, revision: string | null, envNames: string[], requiredEnv: string[], configuration: ConfigSource | null = null, externalRequirements: DeploymentPlan['externalRequirements'] = []): Promise<ResolvedPlan> {
  const contextDir = await appRoot(clone, settings.rootDir);
  const root = normalizeRootDir(settings.rootDir);
  const own = !!await entry(contextDir, 'Dockerfile');
  const generated = !!settings.preset || !own && settings.buildMode !== 'DOCKERFILE';
  const rule = settings.preset ? 'preset' : generated ? 'auto-detect' : 'repo Dockerfile';
  const detection = generated ? settings.preset ? await detectPreset(contextDir, settings.preset, settings.entrypoint) : await detect(contextDir, settings.entrypoint) : undefined;
  const text = detection ? render(detection, { ...ctx, startCommand: settings.startCommand, buildCommand: settings.buildCommand }) : await file(contextDir, 'Dockerfile');
  if (text === null) throw new Error('Dockerfile rejected: No Dockerfile found at the repository root');
  const problems = lintDockerfile(text, { maxBytes });
  if (problems.length) throw new Error(`Dockerfile rejected: ${problems.join('; ')}`);
  const scope: DeploymentPlan['scope'] = !detection ? 'dockerfile' : detection.parameters.kind === 'fullstack' ? 'cohosted-frontend-api' : detection.parameters.kind === 'static' || detection.parameters.kind === 'node' && ['vite', 'cra'].includes(detection.parameters.framework) ? 'static-assets' : 'web-service';
  const relative = (value: string) => root === '.' ? value : value === '.' ? root : `${root}/${value}`;
  const components: DeploymentPlan['components'] = [];
  const component = (app: Exclude<AppSpec, { kind: 'fullstack' }>, frontend: boolean, port: number) => {
    const build = app.kind === 'node' ? nodeBuild(app, frontend ? settings.buildCommand : scope === 'cohosted-frontend-api' ? null : settings.buildCommand) : null;
    components.push({ root: relative(app.root), framework: app.kind === 'static' ? 'static' : app.framework,
      runtime: app.kind === 'static' || frontend ? 'nginx' : app.kind === 'node' ? app.image : scope === 'cohosted-frontend-api' ? 'python:3.12-alpine' : 'python:3.12-slim',
      manager: app.kind === 'node' ? app.manager : app.kind === 'python' ? 'pip' : null,
      install: app.kind === 'node' ? nodeInstallCommand(app, !build) : app.kind === 'python' ? pythonInstallCommand(app) : null,
      build, start: frontend || app.kind === 'static' ? 'nginx (managed static server)' : app.kind === 'node' ? nodeStart(app, settings.startCommand) : pythonStart(app, settings.startCommand),
      output: app.kind === 'static' || app.kind === 'node' && frontend ? app.output : null, port });
  };
  if (detection?.parameters.kind === 'fullstack') {
    component(detection.parameters.frontend, true, ctx.port);
    component(detection.parameters.backend, false, ctx.port === 4000 ? 4001 : 4000);
  } else if (detection) component(detection.parameters, scope === 'static-assets', ctx.port);
  const details = { version: PLAN_VERSION, revision, root, rule, stack: detection?.stack ?? 'Dockerfile', scope, configuration,
    confidence: detection ? 'manifest-and-entrypoint' as const : 'user-dockerfile' as const,
    evidence: (detection?.evidence ?? ['Dockerfile']).map(relative), port: ctx.port, healthPath: ctx.healthPath ?? '/',
    healthMode: settings.healthPath != null || (ctx.healthPath ?? '/') !== '/' || scope === 'static-assets' || scope === 'cohosted-frontend-api' ? 'readiness' as const : 'liveness' as const, limits: ctx.limits,
    releaseCommand: settings.releaseCommand ?? null, seedCommand: settings.seedCommand ?? null, requiredEnv: [...requiredEnv].sort(), components, externalRequirements,
    verification: 'HTTP checks only; application workflows and external credentials are unverified' as const };
  return { settings, contextDir, text, generated, detection, warning: settings.preset && own ? 'Explicit preset overrides the repository Dockerfile; ignoring that Dockerfile' : undefined,
    plan: { ...details, id: hash(JSON.stringify([SUPPORT_VERSION, details, [...envNames].sort(), hash(text)])) } };
}
