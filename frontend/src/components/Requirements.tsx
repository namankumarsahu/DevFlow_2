import { FormEvent, useEffect, useState } from 'react';
import { api, Project } from '../api';

export type Finding = { id: string; severity: 'blocker' | 'warning' | 'info'; message: string; fix: string; evidence: { file: string; line: number }[]; action?: { type: 'set-port'; port: number } | { type: 'add-env'; name: string } };
export type DeploymentPlan = { version: number; id: string; revision: string | null; root: string; scope: string; port: number; healthPath: string; evidence: string[]; limits: { memoryMb: number; cpus: number; diskMb: number }; releaseCommand: string | null; seedCommand: string | null; components: { root: string; framework: string; runtime: string; install: string | null; build: string | null; start: string; port: number; output: string | null }[]; verification: string; configuration?: { file: string; version: number; dashboardOverrides: string[] } | null };
type EntryChoice = { label: string; rootDir: string; preset: Project['preset']; entrypoint: string | null; scope: string };
export type RequirementsState = { ready: boolean; override: boolean; planId?: string };
export type PreflightResult = { version: number; status: 'supported' | 'supported-with-warnings' | 'unsupported'; reason: string; stack: string | null; findings: Finding[]; requiredEnv: string[]; plan?: DeploymentPlan; choices?: EntryChoice[] };
export default function Requirements({ project, envNames, admin, onState, onChanged }: {
  project: Project; envNames: string[]; admin: boolean;
  onState: (state: RequirementsState) => void; onChanged: () => Promise<void>;
}) {
  const [result, setResult] = useState<PreflightResult>();
  const [checked, setChecked] = useState('');
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState('');
  const [override, setOverride] = useState(false);
  const [retry, setRetry] = useState(0);
  const [envName, setEnvName] = useState('');
  const [envValue, setEnvValue] = useState('');
  const signature = JSON.stringify([project.id, project.repoUrl, project.branch, project.useRepositoryConfig, project.rootDir, project.entrypoint, project.buildMode, project.preset, project.containerPort, project.startCommand, project.buildCommand, project.releaseCommand, project.seedCommand, project.memoryMb, project.cpus, project.diskMb, project.limits?.effective, [...envNames].sort(), project.preflightAt && !project.preflightKey ? 'dirty' : 'clean']);
  useEffect(() => { const timer = setInterval(() => setRetry((n) => n + 1), 5 * 60_000); return () => clearInterval(timer); }, [project.id]);
  useEffect(() => {
    let current = true;
    setChecking(true); setError(''); setOverride(false);
    const timer = setTimeout(() => {
      api<PreflightResult>(`/projects/${project.id}/preflight`, { method: 'POST', body: { force: retry > 0 } })
        .then((value) => { if (current) { setResult(value); setChecked(signature); } })
        .catch((e) => { if (current) { setError(e.message); setChecked(''); } })
        .finally(() => { if (current) setChecking(false); });
    }, 600);
    return () => { current = false; clearTimeout(timer); };
  }, [signature, retry, project.id]);
  const blocked = result?.findings.some((f) => f.severity === 'blocker') ?? true;
  useEffect(() => { onState({ ready: !!result && checked === signature && !checking && (!blocked || admin && override), override: admin && override, planId: result?.plan?.id }); }, [result, checked, signature, checking, blocked, admin, override, onState]);
  async function saveEnv(e: FormEvent) {
    e.preventDefault(); setError('');
    try { await api(`/projects/${project.id}/env`, { method: 'PUT', body: { key: envName, value: envValue } }); setEnvValue(''); setEnvName(''); await onChanged(); setRetry((n) => n + 1); }
    catch (e) { setError((e as Error).message); }
  }
  async function setPort(port: number) {
    setError('');
    try { await api(`/projects/${project.id}`, { method: 'PATCH', body: { containerPort: port } }); await onChanged(); }
    catch (e) { setError((e as Error).message); }
  }
  async function choose(choice: EntryChoice) {
    setError(''); setChecked('');
    try { await api(`/projects/${project.id}`, { method: 'PATCH', body: { useRepositoryConfig: false, rootDir: choice.rootDir, entrypoint: choice.entrypoint, preset: choice.preset, buildMode: 'AUTO' } }); await onChanged(); setRetry(n => n + 1); }
    catch (e) { setError((e as Error).message); }
  }
  return <section className="space-y-3 rounded-lg border border-slate-800 p-4" aria-label="Requirements">
    <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="font-semibold">Requirements</h3>
      <button type="button" disabled={checking} className="rounded bg-slate-700 px-3 py-1 text-sm disabled:opacity-40" onClick={() => setRetry((n) => n + 1)}>Check again</button></div>
    {checking && <p role="status" className="text-sm text-slate-400">Checking repository requirements…</p>}
    {error && <p role="alert" className="text-sm text-rose-400">{error}</p>}
    {result && checked === signature && <>
      <p className={result.status === 'unsupported' ? 'text-rose-400' : result.status === 'supported-with-warnings' ? 'text-amber-200' : 'text-emerald-400'}>{result.status} · {result.stack ?? 'Unknown stack'}</p>
      <p className="text-sm text-slate-400">{result.reason} Checks are heuristic; credentials and application behavior are not proven.</p>
      {!!result.choices?.length && <div className="space-y-2"><h4 className="font-semibold">Choose an application</h4><p className="text-xs text-slate-400">Choosing uses dashboard settings and disables devflow.json defaults. Review commands after choosing.</p>{result.choices.map((choice, index) => <div key={index} className="rounded bg-slate-900 p-3 text-sm"><button type="button" className="text-indigo-400" onClick={() => choose(choice)}>Use {choice.label}</button><p className="text-slate-400">{choice.scope}</p></div>)}</div>}
      {result.plan && <div className="space-y-2 rounded bg-slate-900 p-3 text-sm" aria-label="Deployment plan">
        <h4 className="font-semibold">Deployment plan</h4>
        <p>Revision: <code>{result.plan.revision?.slice(0, 12) ?? 'Unavailable'}</code> · Root: <code>{result.plan.root}</code></p>
        {result.plan.configuration && <p className="text-xs text-slate-400">Configuration: {result.plan.configuration.file} v{result.plan.configuration.version}. Dashboard overrides: {result.plan.configuration.dashboardOverrides.join(', ') || 'none'}.</p>}
        <p>{result.plan.scope === 'static-assets' ? 'Static frontend only. This deployment does not host an API or database.' : result.plan.scope === 'cohosted-frontend-api' ? 'Frontend and API in one container. External services remain separate.' : result.plan.scope === 'dockerfile' ? 'Repository Dockerfile controls the application commands.' : 'HTTP application service.'}</p>
        <p>Health check: GET {result.plan.healthPath} on port {result.plan.port} · {result.plan.limits.memoryMb} MB · {result.plan.limits.cpus} CPU</p>
        {result.plan.components.map((c, i) => <div key={i} className="space-y-1 border-t border-slate-700 pt-2"><p>{c.framework} · {c.root} · {c.runtime} · port {c.port}</p>
          {c.install && <p className="break-all">Install: <code>{c.install}</code></p>}{c.build && <p className="break-all">Build: <code>{c.build}</code></p>}
          <p className="break-all">Start: <code>{c.start}</code></p>{c.output && <p>Output: {c.output}</p>}</div>)}
        {result.plan.releaseCommand && <p className="break-all">Release: <code>{result.plan.releaseCommand}</code></p>}
        {result.plan.seedCommand && <p className="break-all">Seed: <code>{result.plan.seedCommand}</code></p>}
        <p className="text-xs text-slate-400">{result.plan.verification}. A changed revision or plan requires a fresh review.</p>
      </div>}
      <ul className="space-y-3">{result.findings.map((f, index) => <li key={`${f.id}-${index}`} className="rounded bg-slate-900 p-3 text-sm">
        <span className={f.severity === 'blocker' ? 'text-rose-400' : f.severity === 'warning' ? 'text-amber-200' : 'text-sky-300'}>{f.severity.toUpperCase()}</span> · {f.message}
        <p className="mt-1 text-xs text-slate-500">{f.evidence.map((e) => `${e.file}:${e.line}`).join(', ')}</p><p className="mt-1 text-slate-300">{f.fix}</p>
        {f.action?.type === 'set-port' && <button type="button" className="mt-2 text-indigo-400" onClick={() => f.action?.type === 'set-port' && setPort(f.action.port)}>Set port to {f.action.port}</button>}
        {f.action?.type === 'add-env' && <button type="button" className="mt-2 text-indigo-400" onClick={() => f.action?.type === 'add-env' && setEnvName(f.action.name)}>Add {f.action.name} now</button>}
      </li>)}</ul>
      {!!result.requiredEnv.length && <div><h4 className="text-sm font-semibold">Required environment variables to review</h4><p className="text-sm text-slate-400">{result.requiredEnv.join(', ')}</p></div>}
      {admin && blocked && <label className="flex gap-2 text-sm text-amber-200"><input type="checkbox" checked={override} onChange={(e) => setOverride(e.target.checked)} />Override blockers for this deployment (admin only; limits still apply)</label>}
    </>}
    {envName && <form onSubmit={saveEnv} className="flex flex-wrap gap-2"><input aria-label="Environment variable name" className="rounded bg-slate-900 px-2 py-1" value={envName} onChange={(e) => setEnvName(e.target.value)} required /><input aria-label="Environment variable value" type="password" autoComplete="off" className="rounded bg-slate-900 px-2 py-1" value={envValue} onChange={(e) => setEnvValue(e.target.value)} required /><button className="rounded bg-indigo-600 px-3 py-1">Save variable and recheck</button></form>}
  </section>;
}
