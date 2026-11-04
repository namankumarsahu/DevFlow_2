export type BuildPreset = 'STATIC' | 'NODE' | 'PYTHON_DJANGO' | 'PYTHON_FLASK' | 'PYTHON_FASTAPI' | 'FULLSTACK';
export type BuildSettings = { buildMode: 'AUTO' | 'DOCKERFILE'; preset: BuildPreset | null; startCommand: string | null; buildCommand: string | null };
export const defaultBuildSettings: BuildSettings = { buildMode: 'AUTO', preset: null, startCommand: null, buildCommand: null };

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
      <label className="text-sm">Start command (optional)
        <input className={input} disabled={ownDockerfile} placeholder="Use detected start command" maxLength={1000}
               value={value.startCommand ?? ''} onChange={(e) => onChange({ ...value, startCommand: e.target.value || null })} />
      </label>
      <label className="text-sm">Build command (optional)
        <input className={input} disabled={ownDockerfile} placeholder="Use detected build command" maxLength={1000}
               value={value.buildCommand ?? ''} onChange={(e) => onChange({ ...value, buildCommand: e.target.value || null })} />
      </label>
      <p className="text-xs text-slate-500 md:col-span-3">Auto-detect uses an existing root Dockerfile first. A selected preset overrides it. Build command applies to Node or the frontend of a monorepo; start command applies to the server. Changes apply on the next deploy.</p>
    </div>
  );
}
