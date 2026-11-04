import { useEffect, useState } from 'react';
import { api, Usage } from '../api';

const bar = (used: number, max: number) => (
  <div className="mt-1 h-1.5 w-full rounded bg-slate-800">
    <div className={`h-1.5 rounded ${used >= max ? 'bg-rose-500' : 'bg-indigo-500'}`} style={{ width: `${Math.min(100, (used / max) * 100)}%` }} />
  </div>
);

export function useUsage(pollMs = 5000) {
  const [usage, setUsage] = useState<Usage>();
  useEffect(() => {
    const load = () => api<Usage>('/projects/usage').then(setUsage).catch(() => undefined);
    load();
    const t = setInterval(load, pollMs);
    return () => clearInterval(t);
  }, [pollMs]);
  return usage;
}

const minutesUntil = (iso: string | null) => (iso ? Math.max(1, Math.ceil((new Date(iso).getTime() - Date.now()) / 60000)) : 0);

// Always visible on the project list: how much of the demo allowance this account has used.
export default function UsageBanner({ usage }: { usage?: Usage }) {
  if (!usage || !usage.enforced || usage.activeApps.max == null || usage.deployAttempts.max == null) return null;
  const a = usage.activeApps, d = usage.deployAttempts;
  const full = a.used >= a.max!;
  return (
    <section className="rounded-lg border border-slate-800 p-4 text-sm" aria-label="Demo usage">
      <div className="grid gap-4 md:grid-cols-3">
        <div>
          <div className="flex justify-between"><span className="font-medium">Active deployments</span><span>{a.used} of {a.max}</span></div>
          {bar(a.used, a.max!)}
          <p className="mt-1 text-xs text-slate-500">Apps that are queued, building, deploying or running. Failed deployments do not use a slot.</p>
        </div>
        <div>
          <div className="flex justify-between"><span className="font-medium">Deploy attempts this hour</span><span>{d.used} of {d.max}</span></div>
          {bar(d.used, d.max!)}
          <p className="mt-1 text-xs text-slate-500">
            Every deploy, redeploy and rollback counts, even if it fails.
            {d.used >= d.max! && d.resetsAt ? ` Next slot opens in about ${minutesUntil(d.resetsAt)} min.` : ''}
          </p>
        </div>
        <div>
          <div className="flex justify-between"><span className="font-medium">Failed (last 24 h)</span><span>{usage.failedDeployments.last24h}</span></div>
          <p className="mt-1 text-xs text-slate-500">
            {usage.build.inFlight ? 'A build is running now; only one build at a time is allowed. ' : ''}Builds stop after {Math.round(usage.build.timeoutSeconds / 60)} minutes.
          </p>
        </div>
      </div>
      {full && (
        <p className="mt-3 rounded bg-amber-500/10 p-2 text-amber-200">
          Quota reached: you are using all {a.max} active deployment slots. To free one, open a deployed app and press <b>Delete</b>.
          Redeploying an app you already have does not need a new slot.
        </p>
      )}
    </section>
  );
}
