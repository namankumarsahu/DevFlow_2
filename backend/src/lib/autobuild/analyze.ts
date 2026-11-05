import { preflight, PreflightSettings, PreflightResult, summarize } from './preflight';
import { repositoryRevision, resolvePlan, DeploymentPlan, ResolvedPlan } from './plan';
import { RenderContext } from './types';
import { configuredSettings } from './configuration';
import { entryChoices, EntryChoice } from './choices';

export type AnalysisReport = PreflightResult & { plan?: DeploymentPlan; choices?: EntryChoice[] };
export async function analyzeDeployment(repo: string, settings: PreflightSettings, envNames: string[], ctx: RenderContext, maxBytes: number, revision?: string | null): Promise<{ report: AnalysisReport; resolved?: ResolvedPlan }> {
  let source;
  try {
    const configured = await configuredSettings(repo, settings);
    settings = { ...settings, ...configured.settings }; source = configured.source;
    ctx = { ...ctx, healthPath: settings.healthPath ?? ctx.healthPath };
  } catch {
    return { report: summarize([{ id: 'config.invalid', severity: 'blocker', message: 'devflow.json must be a valid version 1 configuration with supported fields only.', evidence: [{ file: 'devflow.json', line: 1 }], fix: 'Follow the repository configuration schema; omit environment values, resource requests, mounts and unknown fields.' }], null, 'repository configuration') };
  }
  let report: AnalysisReport = await preflight(repo, settings, envNames);
  if (report.findings.some(f => ['layout.unrecognized', 'layout.workspace', 'layout.root-directory'].includes(f.id))) report.choices = await entryChoices(repo).catch(() => []);
  try {
    const externalRequirements = report.findings.filter(f => f.id.startsWith('service.')).map(f => ({ kind: f.id.slice('service.'.length), evidence: f.evidence, state: 'configuration-unverified' as const }));
    const resolved = await resolvePlan(repo, settings, ctx, maxBytes, revision === undefined ? await repositoryRevision(repo) : revision, envNames, report.requiredEnv, source, externalRequirements);
    report = { ...report, plan: resolved.plan };
    return { report, resolved };
  } catch {
    if (!report.findings.some(f => f.severity === 'blocker')) report = summarize([...report.findings, { id: 'plan.invalid', severity: 'blocker', message: 'The detected build recipe could not produce a valid deployment plan.', evidence: [{ file: '<plan>', line: 1 }], fix: 'Review build/start settings and Dockerfile policy, then check again.' }], report.stack, report.rule);
    return { report };
  }
}
