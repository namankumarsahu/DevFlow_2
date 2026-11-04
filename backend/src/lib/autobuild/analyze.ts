import { preflight, PreflightSettings, PreflightResult, summarize } from './preflight';
import { repositoryRevision, resolvePlan, DeploymentPlan, ResolvedPlan } from './plan';
import { RenderContext } from './types';

export type AnalysisReport = PreflightResult & { plan?: DeploymentPlan };
export async function analyzeDeployment(repo: string, settings: PreflightSettings, envNames: string[], ctx: RenderContext, maxBytes: number, revision?: string | null): Promise<{ report: AnalysisReport; resolved?: ResolvedPlan }> {
  let report: AnalysisReport = await preflight(repo, settings, envNames);
  try {
    const resolved = await resolvePlan(repo, settings, ctx, maxBytes, revision === undefined ? await repositoryRevision(repo) : revision, envNames, report.requiredEnv);
    report = { ...report, plan: resolved.plan };
    return { report, resolved };
  } catch {
    if (!report.findings.some(f => f.severity === 'blocker')) report = summarize([...report.findings, { id: 'plan.invalid', severity: 'blocker', message: 'The detected build recipe could not produce a valid deployment plan.', evidence: [{ file: '<plan>', line: 1 }], fix: 'Review build/start settings and Dockerfile policy, then check again.' }], report.stack, report.rule);
    return { report };
  }
}
