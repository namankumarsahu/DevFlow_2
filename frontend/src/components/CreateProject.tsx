import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type Project } from '../api';
import BuildFields from './BuildFields';
import HelpLink from './HelpLink';
import type { EntryChoice, PreflightResult } from './Requirements';
import { canDeploy, choiceSettings, defaultBranch, initialSetup, mergeChoices, repositoryIdentity, scopeChoices, setupBody, SKIP_MIGRATIONS, type ScopeChoice, type SetupForm } from '../lib/projectSetup';

const input = 'mt-1 w-full rounded border border-slate-700 bg-slate-900 px-3 py-2 text-sm';
const primary = 'rounded bg-indigo-600 px-5 py-2 text-sm font-medium hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-40';
const signature = (url: string, form: SetupForm) => JSON.stringify([url.trim(), form]);

export default function CreateProject({ onProject, onDeployed }: { onProject: (project: Project) => void; onDeployed: (project: Project) => void }) {
  const [repoUrl, setRepoUrl] = useState('');
  const [form, setForm] = useState(initialSetup);
  const [draft, setDraft] = useState<Project>();
  const [report, setReport] = useState<PreflightResult>();
  const [catalog, setCatalog] = useState<EntryChoice[]>([]);
  const [scopes, setScopes] = useState<ScopeChoice[]>([]);
  const [migrationCommand, setMigrationCommand] = useState<string | null>(null);
  const [envValues, setEnvValues] = useState<Record<string, string>>({});
  const [savedNames, setSavedNames] = useState<string[]>([]);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [advanced, setAdvanced] = useState(false);
  const [checked, setChecked] = useState('');
  const [checkedAt, setCheckedAt] = useState(0);
  const working = useRef(false);
  const mounted = useRef(true);
  const drafts = useRef(new Map<string, Project>());
  const abort = useRef<AbortController>();
  useEffect(() => { mounted.current = true; abort.current = new AbortController(); return () => { mounted.current = false; abort.current?.abort(); }; }, []);
  useEffect(() => {
    if (!checkedAt) return;
    const timer = setTimeout(() => setCheckedAt(0), Math.max(0, checkedAt + 5 * 60_000 - Date.now()));
    return () => clearTimeout(timer);
  }, [checkedAt]);

  const identity = useMemo(() => { try { return repositoryIdentity(repoUrl); } catch { return undefined; } }, [repoUrl]);
  const currentDraft = draft?.repoUrl === identity?.url ? draft : undefined;
  const current = !!checkedAt && checked === signature(repoUrl, form) && Date.now() - checkedAt < 5 * 60_000 && !!currentDraft;
  const pendingVariables = Object.values(envValues).some(value => value !== '');
  const roots = [...new Set([...(report?.plan ? [report.plan.root, ...report.plan.components.map(c => c.root)] : []), ...catalog.map(c => c.rootDir)])];
  const selectedRoot = form.rootDir ?? report?.plan?.root ?? (new Set(catalog.map(c => c.rootDir)).size === 1 ? catalog[0]?.rootDir : undefined);
  const pythonChoices = catalog.filter(c => c.entrypoint && c.rootDir === selectedRoot);
  const names = [...new Set([...(report?.requiredEnv ?? []), ...savedNames])];

  async function analyze(next = form, saveVariables = false, force = false) {
    if (working.current) return;
    working.current = true;
    setForm(next); setBusy('Analyzing repository…'); setError(''); setChecked(''); setCheckedAt(0);
    try {
      const repo = repositoryIdentity(repoUrl);
      let project = drafts.current.get(repo.url);
      if (!currentDraft) { setReport(undefined); setCatalog([]); setScopes([]); setMigrationCommand(null); setEnvValues({}); setSavedNames([]); }
      let branch = next.branch || project?.branch;
      if (!branch) {
        try { branch = await defaultBranch(repo, abort.current?.signal); }
        catch (e) { if (mounted.current) setAdvanced(true); throw e; }
      }
      if (!mounted.current) return;
      const body = setupBody(next, repo, branch);
      if (project) {
        const { repoUrl: _repoUrl, ...settings } = body;
        project = await api<Project>(`/projects/${project.id}`, { method: 'PATCH', body: settings });
      } else {
        project = await api<Project>('/projects', { method: 'POST', body });
      }
      drafts.current.set(repo.url, project);
      if (!mounted.current) return;
      setDraft(project); onProject(project);
      if (saveVariables) {
        setBusy('Saving variables and analyzing…');
        for (const [key, value] of Object.entries(envValues).filter(([, value]) => value !== '')) {
          await api(`/projects/${project.id}/env`, { method: 'PUT', body: { key, value } });
          if (!mounted.current) return;
          setSavedNames(previous => [...new Set([...previous, key])]);
          setEnvValues(previous => ({ ...previous, [key]: '' }));
        }
      }
      let result = await api<PreflightResult>(`/projects/${project.id}/preflight`, { method: 'POST', body: { force } });
      if (!mounted.current) return;
      setCatalog(previous => mergeChoices(previous, result.choices));
      // One unambiguous suggestion needs no question. Re-run the same validated
      // project endpoints once; never guess entry points or loop on detection.
      if (!result.plan && result.choices?.length === 1 && result.findings.some(f => ['layout.unrecognized', 'layout.root-directory'].includes(f.id))) {
        next = choiceSettings(next, result.choices[0]);
        setForm(next);
        project = await api<Project>(`/projects/${project.id}`, { method: 'PATCH', body: { ...next, name: body.name, branch: body.branch } });
        if (!mounted.current) return;
        drafts.current.set(repo.url, project); setDraft(project); onProject(project);
        result = await api<PreflightResult>(`/projects/${project.id}/preflight`, { method: 'POST', body: {} });
      }
      if (!mounted.current) return;
      setReport(result); setCatalog(previous => mergeChoices(previous, result.choices));
      const detectedScopes = scopeChoices(result, next);
      if (detectedScopes.length) setScopes(detectedScopes);
      if (result.plan?.releaseCommand !== SKIP_MIGRATIONS) setMigrationCommand(result.plan?.releaseCommand ?? null);
      setChecked(signature(repoUrl, next)); setCheckedAt(Date.now());
    } catch (e) { if (mounted.current) setError((e as Error).message); }
    finally { working.current = false; if (mounted.current) setBusy(''); }
  }

  async function deploy() {
    if (working.current) return;
    if (!current || !canDeploy(report) || pendingVariables || !currentDraft) {
      setError('Analyze the current settings and save any entered variables before deploying.'); return;
    }
    working.current = true; setBusy('Starting deployment…'); setError('');
    try {
      await api(`/projects/${currentDraft.id}/deploy`, { method: 'POST', body: { planId: report!.plan!.id, overridePreflight: false } });
      if (mounted.current) onDeployed(currentDraft);
    } catch (e) { if (mounted.current) { setError((e as Error).message); setChecked(''); setCheckedAt(0); } }
    finally { working.current = false; if (mounted.current) setBusy(''); }
  }

  function choose(choice: EntryChoice) { void analyze(choiceSettings(form, choice)); }
  function chooseFolder(root: string) {
    const candidates = catalog.filter(choice => choice.rootDir === root);
    choose(candidates.length === 1 ? candidates[0] : { label: root, rootDir: root, entrypoint: null, preset: null, scope: 'Selected app only' });
  }

  return <section className="space-y-4 rounded-xl border border-slate-800 bg-slate-950/40 p-5" aria-label="Create project">
    <div><h1 className="text-xl font-semibold">Create project</h1><p className="mt-1 text-sm text-slate-400">Paste a repository. Review the plan, then deploy.</p></div>
    <form onSubmit={event => { event.preventDefault(); void analyze(form, false, true); }} className="flex flex-wrap items-end gap-3" aria-label="Analyze repository">
      <label className="min-w-0 flex-1 text-sm">Repository URL<HelpLink topic="Analyze" text="Analyze saves an undeployed project and checks its repository. It uses a project slot, not a deployment attempt." />
        <input className={input} type="url" placeholder="https://github.com/owner/repository" aria-label="Repository URL" value={repoUrl} required disabled={!!busy}
          onChange={event => { setRepoUrl(event.target.value); setChecked(''); setCheckedAt(0); setError(''); setEnvValues({}); setSavedNames([]); setReport(undefined); setCatalog([]); setScopes([]); setMigrationCommand(null); }} />
      </label>
      <button type="submit" className={primary} disabled={!!busy || !repoUrl.trim()}>{report && currentDraft ? 'Analyze again' : 'Analyze'}</button>
    </form>
    {busy && <p role="status" className="text-sm text-indigo-300">{busy}</p>}
    {error && <p role="alert" className="text-sm text-rose-400">{error}</p>}

    {report && currentDraft && <section className="space-y-4 rounded-lg border border-slate-700 p-4" aria-label="Deployment review">
      <div className="flex flex-wrap justify-between gap-2"><div><h2 className="font-semibold">{report.stack ?? 'Choose an application'}</h2>
        <p className="text-sm text-slate-400">{currentDraft.name} · {currentDraft.branch}</p></div>
        <span className={`text-sm ${canDeploy(report) ? 'text-emerald-300' : 'text-amber-300'}`}>{canDeploy(report) ? 'Ready for review' : 'Needs attention'}</span></div>
      {!!scopes.length && <fieldset disabled={!!busy} className="space-y-2"><legend className="text-sm font-medium">Apps to deploy</legend><div className="flex flex-wrap gap-4">
        {scopes.map(scope => <label key={scope.id} className="flex items-center gap-2 text-sm"><input type="radio" name="app-scope" value={scope.id}
          checked={Object.entries(scope.settings).every(([key, value]) => form[key as keyof SetupForm] === value)}
          onChange={() => void analyze({ ...form, ...scope.settings })} />{scope.label}</label>)}
      </div></fieldset>}
      {!scopes.length && new Set(catalog.map(choice => choice.rootDir)).size > 1 && <label className="block text-sm">App folder
        <select className={input} aria-label="App folder" value={selectedRoot ?? ''} disabled={!!busy} onChange={event => chooseFolder(event.target.value)}>
          <option value="" disabled>Choose a detected app folder</option>{[...new Set(catalog.map(choice => choice.rootDir))].map(root => <option key={root}>{root}</option>)}
        </select></label>}
      {pythonChoices.length > 1 && <label className="block text-sm">Python entry point
        <select className={input} aria-label="Python entry point" value={form.entrypoint ?? ''} disabled={!!busy} onChange={event => choose(pythonChoices.find(choice => choice.entrypoint === event.target.value)!)}>
          <option value="" disabled>Choose a detected entry point</option>{pythonChoices.map(choice => <option key={choice.entrypoint} value={choice.entrypoint!}>{choice.entrypoint}</option>)}
        </select></label>}
      {report.plan && <div className="space-y-3" aria-label="What will run">
        <p className="text-sm text-slate-400">{report.plan.scope === 'static-assets' ? 'Static frontend only' : report.plan.scope === 'cohosted-frontend-api' ? 'Frontend and API in one container' : report.plan.scope === 'dockerfile' ? 'Repository Dockerfile' : 'Web service'} · Folder: <code>{report.plan.root}</code></p>
        {report.plan.components.map((component, index) => <div key={index} className="rounded bg-slate-900 p-3 text-sm">
          <p className="font-medium">{component.framework} · <code>{component.root}</code></p>
          <p className="mt-1 break-all text-slate-300">Build: <code>{component.build ?? 'No build step'}</code></p>
          <p className="break-all text-slate-300">Start: <code>{component.start}</code></p>
        </div>)}
        {report.plan.scope === 'dockerfile' && <p className="text-sm text-slate-400">Build and start commands are defined by the repository Dockerfile.</p>}
      </div>}
      {!!names.length && <fieldset disabled={!!busy} className="space-y-3"><legend className="text-sm font-medium">Environment variables<HelpLink topic="Environment variables" text="Values are saved through the encrypted environment API. Browser build-time variables need separate configuration." /></legend>
        {names.map(name => <label key={name} className="block text-sm"><span className="font-mono">{name}</span>
          <span className="ml-2 text-xs text-slate-400">{savedNames.includes(name) ? 'Saved' : report.findings.some(f => f.id === `env.missing.${name}` && f.severity === 'blocker') ? 'Required' : 'Review / optional'}</span>
          <input className={input} aria-label={name} type="password" autoComplete="new-password" maxLength={4096} value={envValues[name] ?? ''} placeholder={savedNames.includes(name) ? 'Saved — enter a value to replace it' : 'Enter value'} onChange={event => setEnvValues(previous => ({ ...previous, [name]: event.target.value }))} />
        </label>)}
        <button type="button" className="rounded bg-slate-700 px-3 py-2 text-sm disabled:opacity-40" disabled={!!busy || !pendingVariables} onClick={() => void analyze(form, true)}>Save variables and analyze</button>
      </fieldset>}
      <div className="space-y-1"><label className="flex items-center gap-2 text-sm"><input type="checkbox" aria-label="Run database migrations on deploy"
        checked={!!report.plan?.releaseCommand && report.plan.releaseCommand !== SKIP_MIGRATIONS} disabled={!!busy || !current || !migrationCommand}
        onChange={event => void analyze({ ...form, releaseCommand: event.target.checked ? migrationCommand : SKIP_MIGRATIONS })} />Run database migrations on deploy
        <HelpLink topic="Migrations" text="Uses the reported release command. Skipping overrides inherited migrations without disabling other repository defaults." /></label>
        <p className="break-all text-xs text-slate-400">{migrationCommand ? <code>{migrationCommand}</code> : 'No release command detected. Add one under Advanced if needed.'}</p>
      </div>
      {!!report.findings.length && <ul className="space-y-2" aria-label="Warnings and blockers">{report.findings.map((finding, index) => <li key={`${finding.id}-${index}`} className={`rounded border p-3 text-sm ${finding.severity === 'blocker' ? 'border-rose-900 bg-rose-950/20' : 'border-slate-800 bg-slate-900'}`}>
        <p><span className={finding.severity === 'blocker' ? 'font-semibold text-rose-300' : 'font-medium text-amber-200'}>{finding.severity === 'blocker' ? 'Blocker' : finding.severity === 'warning' ? 'Warning' : 'Note'}:</span> {finding.message}</p>
        <p className="mt-1 text-xs text-slate-400">{finding.fix}</p>
      </li>)}</ul>}
      {!current && !busy && <p role="status" className="text-sm text-amber-200">Settings changed or the review expired. Analyze again before deploying.</p>}
      {pendingVariables && <p className="text-xs text-amber-200">Save the entered variables before deploying.</p>}
      <div className="flex flex-wrap items-center gap-3"><button type="button" className={primary} disabled={!!busy || !current || !canDeploy(report) || pendingVariables} onClick={() => void deploy()}>Deploy</button>
        <Link to={`/projects/${currentDraft.id}`} className="text-sm text-slate-400 hover:text-indigo-300">Project settings</Link></div>
      <p className="text-xs text-slate-500">Detection and HTTP checks do not verify application workflows or external credentials.</p>
    </section>}

    <fieldset disabled={!!busy}><details open={advanced} onToggle={event => setAdvanced(event.currentTarget.open)} className="rounded-lg border border-slate-800">
      <summary onClick={event => { event.preventDefault(); setAdvanced(value => !value); }} className="cursor-pointer px-4 py-3 text-sm text-slate-300">Advanced settings</summary>
      {advanced && <div className="space-y-4 border-t border-slate-800 p-4">
        <div className="grid gap-3 md:grid-cols-2">
          <label className="text-sm">Project name<input className={input} aria-label="Project name" maxLength={60} placeholder={identity?.name || 'Derived from the repository'} value={form.name} onChange={event => setForm({ ...form, name: event.target.value })} /></label>
          <label className="text-sm">Branch<input className={input} aria-label="Branch" maxLength={100} placeholder={currentDraft?.branch || 'Default branch from GitHub'} value={form.branch} onChange={event => setForm({ ...form, branch: event.target.value })} /></label>
          <label className="text-sm">Environment<select className={input} aria-label="Environment" value={form.environment} onChange={event => setForm({ ...form, environment: event.target.value as SetupForm['environment'] })}><option>PRODUCTION</option><option>STAGING</option><option>DEVELOPMENT</option></select></label>
          <label className="text-sm">Container port<HelpLink topic="Port" text="The platform passes $PORT. Most apps should use the default port and bind to 0.0.0.0." /><input className={input} aria-label="Container port" type="number" min={1} max={65535} value={form.containerPort} onChange={event => setForm({ ...form, containerPort: Number(event.target.value) })} /></label>
        </div>
        <BuildFields value={form} onChange={settings => setForm({ ...form, ...settings })} rootChoices={roots} entrypointChoices={pythonChoices.map(choice => choice.entrypoint!)} detectedRelease={report?.plan?.releaseCommand} detectedSeed={report?.plan?.seedCommand} />
        {report?.plan?.seedCommand && !form.seedCommand && <p className="break-all text-xs text-slate-400">Repository seed command: <code>{report.plan.seedCommand}</code></p>}
        <button type="button" className="rounded bg-slate-700 px-3 py-2 text-sm" disabled={!repoUrl.trim()} onClick={() => void analyze(form)}>Analyze settings</button>
      </div>}
    </details></fieldset>
  </section>;
}
