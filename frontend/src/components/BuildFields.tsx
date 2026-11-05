import HelpLink from './HelpLink';
export type BuildPreset = 'STATIC' | 'NODE' | 'PYTHON_DJANGO' | 'PYTHON_FLASK' | 'PYTHON_FASTAPI' | 'FULLSTACK';
export type BuildSettings = { healthPath: string | null; useRepositoryConfig: boolean; rootDir: string | null; entrypoint: string | null; buildMode: 'AUTO' | 'DOCKERFILE'; preset: BuildPreset | null; startCommand: string | null; buildCommand: string | null; releaseCommand: string | null; seedCommand: string | null };
export const defaultBuildSettings: BuildSettings = { healthPath: null, useRepositoryConfig: true, rootDir: null, entrypoint: null, buildMode: 'AUTO', preset: null, startCommand: null, buildCommand: null, releaseCommand: null, seedCommand: null };

export default function BuildFields({ value, onChange, rootChoices = [], entrypointChoices = [], detectedRelease, detectedSeed }: {
  value: BuildSettings; onChange: (settings: BuildSettings) => void; rootChoices?: string[]; entrypointChoices?: string[]; detectedRelease?: string | null; detectedSeed?: string | null;
}) {
  const input = 'mt-1 w-full rounded bg-slate-900 px-3 py-2 text-sm';
  const ownDockerfile = value.buildMode === 'DOCKERFILE' && !value.preset;
  return (
    <div className="grid gap-3 md:grid-cols-3">
      <label className="text-sm">Build type<HelpLink topic="Build type" text="Auto-detect honors a repository Dockerfile; an explicit preset overrides it." />
        <select className={input} value={value.preset ?? value.buildMode} onChange={(e) => {
          const selected = e.target.value;
          onChange({ ...value, buildMode: selected === 'DOCKERFILE' ? 'DOCKERFILE' : 'AUTO', preset: selected === 'AUTO' || selected === 'DOCKERFILE' ? null : selected as BuildPreset });
        }}>
          <option value="AUTO">Auto-detect</option><option value="STATIC">Static site</option><option value="NODE">Node</option>
          <option value="PYTHON_DJANGO">Django</option><option value="PYTHON_FLASK">Flask</option><option value="PYTHON_FASTAPI">FastAPI</option>
          <option value="FULLSTACK">Frontend + backend</option><option value="DOCKERFILE">My own Dockerfile</option>
        </select>
      </label>
      <label className="text-sm">Root directory (optional)<HelpLink topic="App folder" text="Only this folder is built. An unset folder inherits repository defaults." />
        {rootChoices.length ? <select aria-label="Root directory (optional)" className={input} value={value.rootDir ?? ''} onChange={e => onChange({ ...value, rootDir: e.target.value || null, entrypoint: null })}>
          <option value="">Use repository default</option>{[...new Set([...rootChoices, ...(value.rootDir ? [value.rootDir] : [])])].map(root => <option key={root} value={root}>{root}</option>)}
        </select> : <input aria-label="Root directory (optional)" className={input} placeholder="Repository root, or e.g. frontend" maxLength={200} value={value.rootDir ?? ''}
               onChange={(e) => onChange({ ...value, rootDir: e.target.value || null, entrypoint: null })} />}
      </label>
      <label className="text-sm">Start command (optional)
        <input className={input} disabled={ownDockerfile} placeholder="Use detected start command" maxLength={1000}
               value={value.startCommand ?? ''} onChange={(e) => onChange({ ...value, startCommand: e.target.value || null })} />
      </label>
      <label className="text-sm">Python entry point (optional)<HelpLink topic="Python entry point" text="Choose a detected module:application. Custom factories may require a Dockerfile." />
        {entrypointChoices.length ? <select aria-label="Python entry point (optional)" className={input} disabled={ownDockerfile} value={value.entrypoint ?? ''} onChange={e => onChange({ ...value, entrypoint: e.target.value || null })}>
          <option value="">Use detected default</option>{[...new Set([...entrypointChoices, ...(value.entrypoint ? [value.entrypoint] : [])])].map(target => <option key={target}>{target}</option>)}
        </select> : <input aria-label="Python entry point (optional)" className={input} disabled={ownDockerfile} placeholder="e.g. main:app" maxLength={200} value={value.entrypoint ?? ''}
               onChange={(e) => onChange({ ...value, entrypoint: e.target.value || null })} />}
      </label>
      <label className="text-sm">Health check path (optional)
        <input className={input} placeholder="Inherited, usually /; e.g. /ready" maxLength={200} value={value.healthPath ?? ''} onChange={e => onChange({ ...value, healthPath: e.target.value || null })} />
      </label>
      <label className="text-sm">Build command (optional)
        <input className={input} disabled={ownDockerfile} placeholder="Use detected build command" maxLength={1000}
               value={value.buildCommand ?? ''} onChange={(e) => onChange({ ...value, buildCommand: e.target.value || null })} />
      </label>
      <label className="text-sm">Release command (optional)<HelpLink topic="Migrations" text="Runs before traffic switches. Use an external database; null inherits devflow.json." />
        <input aria-label="Release command (optional)" className={input} placeholder={detectedRelease || 'e.g. npx prisma migrate deploy'} maxLength={1000} value={value.releaseCommand ?? ''}
               onChange={(e) => onChange({ ...value, releaseCommand: e.target.value || null })} />
      </label>
      <label className="text-sm">Seed command (optional, idempotent)<HelpLink topic="Seed command" text="Runs separately before traffic switches. Local SQLite files and uploads are not shared with the app." />
        <input aria-label="Seed command (optional, idempotent)" className={input} placeholder={detectedSeed || 'Initialize an external database'} maxLength={1000} value={value.seedCommand ?? ''}
               onChange={(e) => onChange({ ...value, seedCommand: e.target.value || null })} />
      </label>
      <label className="flex gap-2 text-sm md:col-span-3"><input type="checkbox" checked={value.useRepositoryConfig} onChange={e => onChange({ ...value, useRepositoryConfig: e.target.checked })} />Use devflow.json defaults<HelpLink topic="Repository configuration" text="Unset fields inherit repository defaults; explicit dashboard settings take precedence." page="REPOSITORY-CONFIGURATION.md" /></label>
    </div>
  );
}
