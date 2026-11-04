export type StrategyId = string;
export type Preset = 'STATIC' | 'NODE' | 'PYTHON_DJANGO' | 'PYTHON_FLASK' | 'PYTHON_FASTAPI' | 'FULLSTACK';
export type NodeApp = {
  kind: 'node'; root: string; framework: 'vite' | 'cra' | 'next' | 'node'; image: string;
  manager: 'npm' | 'yarn' | 'pnpm'; managerVersion: string; manifests: string[];
  hasBuild: boolean; hasStart: boolean; main: string | null; output: string;
};
export type PythonApp = {
  kind: 'python'; root: string; framework: 'django' | 'flask' | 'fastapi';
  manifest: string; target: string; server: 'gunicorn' | 'uvicorn';
  settingsModule?: string;
};
export type StaticApp = { kind: 'static'; root: string; output: string };
export type FullstackApp = { kind: 'fullstack'; frontend: NodeApp | StaticApp; backend: NodeApp | PythonApp };
export type AppSpec = NodeApp | PythonApp | StaticApp | FullstackApp;
export type Detection<P = AppSpec> = { strategyId: StrategyId; stack: string; evidence: string[]; parameters: P };
export type RenderContext = {
  port: number; limits: { memoryMb: number; cpus: number; diskMb: number };
  startCommand?: string | null; buildCommand?: string | null;
};
// A future BuildpackStrategy can implement this interface and render a Dockerfile
// which invokes its lifecycle inside BuildKit. Detection must remain read-only.
export interface BuildStrategy<P = any> {
  id: string;
  detect(repoDir: string): Promise<Detection<P> | null>;
  render(detection: Detection<P>, ctx: RenderContext): string;
}
export type BuildSettings = { rootDir?: string | null; buildMode?: 'AUTO' | 'DOCKERFILE'; preset?: Preset | null; startCommand?: string | null; buildCommand?: string | null };
export type BuildPlan = {
  rule: 'preset' | 'repo Dockerfile' | 'auto-detect'; stack: string; evidence: string[];
  dockerfileDir: string; contextDir?: string; generated: boolean; warning?: string;
};
