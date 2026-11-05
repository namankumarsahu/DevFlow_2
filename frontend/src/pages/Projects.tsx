import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, Project } from '../api';
import UsageBanner, { useUsage } from '../components/UsageBanner';
import CreateProject from '../components/CreateProject';

export default function Projects() {
  const navigate = useNavigate();
  const [projects, setProjects] = useState<Project[]>([]);
  const [error, setError] = useState('');
  const usage = useUsage();

  const load = () => api<Project[]>('/projects').then(incoming => setProjects(current => [...current, ...incoming.filter(project => !current.some(p => p.id === project.id))]));
  useEffect(() => { void load().catch(err => setError(err.message)); }, []);

  const remember = (project: Project) => setProjects(previous => previous.some(p => p.id === project.id) ? previous.map(p => p.id === project.id ? project : p) : [project, ...previous]);
  return (
    <div className="space-y-8">
      <UsageBanner usage={usage} />
      <CreateProject onProject={remember} onDeployed={project => navigate(`/projects/${project.id}`)} />
      {error && <p role="alert" className="text-sm text-rose-400">{error}</p>}

      <div className="grid gap-4 md:grid-cols-2">
        {projects.map((p) => (
          <Link key={p.id} to={`/projects/${p.id}`} className="rounded-lg border border-slate-800 p-4 hover:border-indigo-500">
            <div className="flex items-center justify-between">
              <h3 className="font-semibold">{p.name}</h3>
              <span className="rounded bg-slate-800 px-2 py-0.5 text-xs">{p.environment}</span>
            </div>
            <p className="mt-1 truncate text-sm text-slate-400">{p.repoUrl} · {p.branch}</p>
            {usage?.enforced && <p className="mt-2 text-xs text-slate-500">{usage.activeApps.projectIds.includes(p.id) ? '● uses 1 active deployment slot' : 'no slot used'}</p>}
          </Link>
        ))}
        {projects.length === 0 && <p className="text-slate-500">No projects yet — create one above.</p>}
      </div>
    </div>
  );
}
