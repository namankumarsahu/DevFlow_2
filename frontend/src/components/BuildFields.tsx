export type BuildPreset = 'STATIC' | 'NODE' | 'PYTHON_DJANGO' | 'PYTHON_FLASK' | 'PYTHON_FASTAPI' | 'FULLSTACK';
export type BuildSettings = { useRepositoryConfig: boolean; rootDir: string | null; entrypoint: string | null; buildMode: 'AUTO' | 'DOCKERFILE'; preset: BuildPreset | null; startCommand: string | null; buildCommand: string | null; releaseCommand: string | null; seedCommand: string | null };
export const defaultBuildSettings: BuildSettings = { useRepositoryConfig: true, rootDir: null, entrypoint: null, buildMode: 'AUTO', preset: null, startCommand: null, buildCommand: null, releaseCommand: null, seedCommand: null };

export default function BuildFields({ value, onChange }: { value: BuildSettings; onChange: (settings: BuildSettings) => void }) {
  const input = 'mt-1 w-full rounded bg-slate-900 px-3 py-2 text-sm';
  const ownDockerfile = value.buildMode === 'DOCKERFILE' && !value.preset;
  return (
    <div className="grid gap-3 md:grid-cols-3">
      <label className="text-sm">Build type
        <select className={input} value={value.preset ?? value.buildMode} onChange={(e) => {
          const selected = e.target.value;
          onChange({ ...value, buildMode: selected === 'DOCKERFILE' ? 'DOCKERFILE' : 'AUTO', preset: selected === 'AUTO' || selected === 'DOCKERFILE' ? null : selected as BuildPreset });
        }}>
          <option value="AUTO">Auto-detect</option><option value="STATIC">Static site</option><option value="NODE">Node</option>
          <option value="PYTHON_DJANGO">Django</option><option value="PYTHON_FLASK">Flask</option><option value="PYTHON_FASTAPI">FastAPI</option>
          <option value="FULLSTACK">Frontend + backend</option><option value="DOCKERFILE">My own Dockerfile</option>
        </select>
      </label>
      <label className="text-sm">Root directory (optional)
        <input className={input} placeholder="Repository root, or e.g. frontend" maxLength={200} value={value.rootDir ?? ''}
               onChange={(e) => onChange({ ...value, rootDir: e.target.value || null })} />
      </label>
      <label className="text-sm">Start command (optional)
        <input className={input} disabled={ownDockerfile} placeholder="Use detected start command" maxLength={1000}
               value={value.startCommand ?? ''} onChange={(e) => onChange({ ...value, startCommand: e.target.value || null })} />
      </label>
      <label className="text-sm">Python entry point (optional)
        <input className={input} disabled={ownDockerfile} placeholder="e.g. main:app" maxLength={200} value={value.entrypoint ?? ''}
               onChange={(e) => onChange({ ...value, entrypoint: e.target.value || null })} />
      </label>
      <label className="text-sm">Build command (optional)
        <input className={input} disabled={ownDockerfile} placeholder="Use detected build command" maxLength={1000}
               value={value.buildCommand ?? ''} onChange={(e) => onChange({ ...value, buildCommand: e.target.value || null })} />
      </label>
      <label className="text-sm">Release command (optional)
        <input className={input} placeholder="e.g. npx prisma migrate deploy" maxLength={1000} value={value.releaseCommand ?? ''}
               onChange={(e) => onChange({ ...value, releaseCommand: e.target.value || null })} />
      </label>
      <label className="text-sm">Seed command (optional, idempotent)
        <input className={input} placeholder="Initialize an external database" maxLength={1000} value={value.seedCommand ?? ''}
               onChange={(e) => onChange({ ...value, seedCommand: e.target.value || null })} />
      </label>
      <p className="text-xs text-amber-200 md:col-span-3">Release and seed run in separate containers before traffic switches. Use an external database; local SQLite files and uploads are not shared or persisted across replacements.</p>
      <p className="text-xs text-slate-500 md:col-span-3">Only the selected directory is built; choosing frontend deploys the frontend alone. Leave it blank for full-repository detection. Auto-detect uses a Dockerfile in that directory first; a preset overrides it. Changes apply on the next deploy.</p>
      <p className="text-xs text-slate-500 md:col-span-3">Unset fields inherit devflow.json from the repository root. Explicit dashboard values override it; use root directory . to override a configured folder. API keys belong in environment variables.</p>
      <label className="flex gap-2 text-sm md:col-span-3"><input type="checkbox" checked={value.useRepositoryConfig} onChange={e => onChange({ ...value, useRepositoryConfig: e.target.checked })} />Use devflow.json defaults. Disable to use dashboard settings and automatic detection only.</label>
    </div>
  );
}
