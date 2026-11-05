import { z } from 'zod';
import { entry, file } from './files';
import { validRootDir } from './root';
import { validCommand } from './render';
import { BuildSettings } from './types';

export const validEntrypoint = (value: string) => value.length <= 200 && value === value.trim() && /^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*:[A-Za-z_]\w*$/.test(value);
const command = z.string().min(1).max(1000).refine(value => validCommand(value) && !!value.trim()).nullable();
const schema = z.object({
  version: z.literal(1),
  rootDir: z.string().min(1).max(200).refine(validRootDir).nullable().optional(),
  buildMode: z.enum(['AUTO', 'DOCKERFILE']).optional(),
  preset: z.enum(['STATIC', 'NODE', 'PYTHON_DJANGO', 'PYTHON_FLASK', 'PYTHON_FASTAPI', 'FULLSTACK']).nullable().optional(),
  entrypoint: z.string().refine(validEntrypoint).nullable().optional(),
  buildCommand: command.optional(), startCommand: command.optional(),
  releaseCommand: command.optional(), seedCommand: command.optional(),
}).strict();
export type ConfigurableSettings = BuildSettings & { releaseCommand?: string | null; seedCommand?: string | null };
export type ConfigSource = { file: 'devflow.json'; version: 1; dashboardOverrides: string[] };

// Configuration is data: it cannot import code, define environment values,
// request mounts/networks/resources, or escape the clone.
export async function configuredSettings(repo: string, project: ConfigurableSettings): Promise<{ settings: ConfigurableSettings; source: ConfigSource | null }> {
  if (project.useRepositoryConfig === false) return { settings: project, source: null };
  const info = await entry(repo, 'devflow.json');
  if (!info) return { settings: project, source: null };
  if (!info.isFile() || info.size > 16 * 1024) throw new Error('Invalid repository configuration');
  let parsed: z.infer<typeof schema>;
  try { parsed = schema.parse(JSON.parse((await file(repo, 'devflow.json'))!)); }
  catch { throw new Error('Invalid repository configuration'); } // Never echo JSON values or parser snippets.
  const { version, ...defaults } = parsed;
  const settings: ConfigurableSettings = { ...defaults, ...project };
  const dashboardOverrides: string[] = [];
  for (const key of ['rootDir', 'preset', 'entrypoint', 'buildCommand', 'startCommand', 'releaseCommand', 'seedCommand'] as const) {
    Object.assign(settings, { [key]: project[key] ?? defaults[key] ?? null });
    if (project[key] != null && defaults[key] !== undefined) dashboardOverrides.push(key);
  }
  settings.buildMode = project.buildMode === 'DOCKERFILE' ? 'DOCKERFILE' : defaults.buildMode ?? project.buildMode ?? 'AUTO';
  if (project.buildMode === 'DOCKERFILE' && !project.preset) { settings.preset = null; settings.entrypoint = null; }
  if (project.buildMode === 'DOCKERFILE' && defaults.buildMode !== undefined) dashboardOverrides.push('buildMode');
  return { settings, source: { file: 'devflow.json', version, dashboardOverrides } };
}
