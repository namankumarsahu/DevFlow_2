import { createHash } from 'crypto';
import { detect, detectPreset } from './selection';
import { at, entry, file, names } from './files';
import { AppSpec, BuildSettings, Detection, RenderContext } from './types';
import { lintDockerfileAt } from '../dockerfileLint';
import { SUPPORT_VERSION, SupportStatus } from './support';
import { appRoot, normalizeRootDir } from './root';

export type Finding = {
  id: string; severity: 'blocker' | 'warning' | 'info'; message: string;
  evidence: { file: string; line: number }[]; fix: string;
  action?: { type: 'set-port'; port: number } | { type: 'add-env'; name: string };
};
export type PreflightResult = {
  version: number; status: SupportStatus; reason: string; stack: string | null;
  rule: string; findings: Finding[]; requiredEnv: string[];
};
export type PreflightSettings = BuildSettings & { containerPort?: number; releaseCommand?: string | null; seedCommand?: string | null; rootDir?: string | null };
export function preflightKey(project: PreflightSettings & { repoUrl?: string; branch?: string }, envNames: string[], context?: RenderContext) {
  return createHash('sha256').update(JSON.stringify([SUPPORT_VERSION, project.repoUrl, project.branch, project.healthPath ?? null, project.useRepositoryConfig ?? true, project.rootDir ?? null, project.entrypoint ?? null, project.buildMode ?? 'AUTO', project.preset ?? null, project.containerPort ?? 3000, project.startCommand ?? null, project.buildCommand ?? null, project.releaseCommand ?? null, project.seedCommand ?? null, [...envNames].sort(), context])).digest('hex');
}
export function summarize(findings: Finding[], stack: string | null, rule: string): PreflightResult {
  const blockers = findings.filter((f) => f.severity === 'blocker');
  const warnings = findings.some((f) => f.severity === 'warning');
  return {
    version: SUPPORT_VERSION, status: blockers.length ? 'unsupported' : warnings ? 'supported-with-warnings' : 'supported',
    reason: blockers.length ? 'Requirements must be resolved before deployment.' : warnings ? 'Supported layout with requirements to review.' : 'Supported layout; no known blockers found.',
    stack, rule, findings, requiredEnv: [...new Set(findings.filter((f) => f.id.startsWith('env.missing.')).map((f) => f.id.slice('env.missing.'.length)))].sort(),
  };
}
const systemEnv = new Set(['PORT', 'HOST', 'NODE_ENV', 'NODE_OPTIONS', 'HOME', 'PATH', 'TMPDIR', 'PYTHONPATH', 'PYTHONUNBUFFERED', 'PYTHONDONTWRITEBYTECODE', 'DJANGO_SETTINGS_MODULE', 'DEVFLOW_URL', 'DEVFLOW_PREVIEW', 'DEVFLOW_PR_NUMBER', 'DEVFLOW_TRUSTED_PROXIES']);
const sourcePattern = /\.(?:[cm]?js|jsx|ts|tsx|py|toml|json|ya?ml|prisma)$/;
const ignored = /(?:^|\/)(?:tests?|__tests__|migrations|dist|build|out|public|node_modules|venv|\.venv)(?:\/|$)|(?:\.test\.|\.spec\.|(?:^|\/)test_|\/tests?\.py$)|(?:package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$/;
function backendSpec(spec?: AppSpec) { return spec?.kind === 'fullstack' ? spec.backend : spec; }

// Pure inspection: reads bounded local files only. Never imports a repository
// module, runs its commands, resolves dependencies, or accesses the network.
async function inspect(repoDir: string, settings: PreflightSettings, envNames: string[]): Promise<PreflightResult> {
  const findings: Finding[] = [];
  const add = (id: string, severity: Finding['severity'], message: string, filename: string, line: number, fix: string, action?: Finding['action']) => {
    if (!findings.some((f) => f.id === id && f.evidence[0]?.file === filename && f.evidence[0]?.line === line)) findings.push({ id, severity, message, evidence: [{ file: filename, line }], fix, ...(action ? { action } : {}) });
  };
  let detection: Detection | undefined;
  const ownDockerfile = !settings.preset && !!(await entry(repoDir, 'Dockerfile'));
  const rule = settings.preset ? 'preset' : ownDockerfile || settings.buildMode === 'DOCKERFILE' ? 'repo Dockerfile' : 'auto-detect';
  try {
    if (ownDockerfile || !settings.preset && settings.buildMode === 'DOCKERFILE') {
      const problems = await lintDockerfileAt(repoDir, { maxBytes: 100 * 1024 });
      if (problems.length) add('layout.dockerfile', 'blocker', 'A valid repository Dockerfile is required.', 'Dockerfile', 1, 'Fix the Dockerfile or choose a supported preset.');
    } else detection = settings.preset ? await detectPreset(repoDir, settings.preset, settings.entrypoint) : await detect(repoDir, settings.entrypoint);
  } catch {
    add('layout.unrecognized', 'blocker', 'No unambiguous supported application entry point was found.', '.', 1, 'Choose a matching preset, use one supported app at the root, or provide a Dockerfile.');
  }
  const spec = detection?.parameters;
  let unsupportedFramework: string | null = null;
  const backend = backendSpec(spec);
  const apps = spec?.kind === 'fullstack' ? [spec.frontend, spec.backend] : spec ? [spec] : [];
  for (const app of apps) if (app.kind === 'node' && (app.workspaceLayout || app.workspaceDependencies)) add('layout.workspace', 'blocker', 'This app requires a workspace-aware install context that the current generated recipe does not provide.', at(app.root, 'package.json'), 1, 'Choose an independent app folder with its own dependencies, or provide a Dockerfile that installs the complete workspace.');
  if (backend?.kind === 'node' && backend.framework === 'node' && !backend.hasStart && !backend.main && !settings.startCommand) add('entry.node', 'blocker', 'Node app has no start script or main entry point.', `${backend.root}/package.json`, 1, 'Add a start script or set Start command.');
  if ((spec?.kind === 'node' && ['vite', 'cra'].includes(spec.framework) || spec?.kind === 'fullstack' && spec.frontend.kind === 'node') && !settings.buildCommand) {
    const front = spec.kind === 'fullstack' ? spec.frontend : spec;
    if (front.kind === 'node' && !front.hasBuild) add('entry.frontend-build', 'blocker', 'Frontend has no build script.', `${front.root}/package.json`, 1, 'Add a build script or set Build command.');
  }
  const generatedServer = backend?.kind === 'node' && backend.framework === 'node';
  const fullstack = spec?.kind === 'fullstack';
  const configured = new Set([...systemEnv, ...envNames]);
  const required = new Map<string, { filename: string; line: number; certain: boolean }>();
  const sources: { filename: string; source: string; scriptLine?: number; checkHost?: boolean }[] = [];
  let scannedBytes = 0;
  for (const filename of await names(repoDir)) {
    if (filename === 'expected.json' || filename === 'devflow.json' || ignored.test(filename) || !sourcePattern.test(filename) && !filename.endsWith('requirements.txt') && filename !== 'Dockerfile') continue;
    if ((await entry(repoDir, filename))!.size > 256 * 1024) { add('scan.large-file', 'warning', 'A large source file was not inspected.', filename, 1, 'Review its startup and configuration manually.'); continue; }
    scannedBytes += (await entry(repoDir, filename))!.size;
    if (scannedBytes > 4 * 1024 * 1024) { if (!findings.some((f) => f.id === 'scan.limit')) add('scan.limit', 'warning', 'The bounded source scan reached 4 MB; some files were not inspected.', '.', 1, 'Review remaining source configuration manually.'); continue; }
    sources.push({ filename, source: await file(repoDir, filename) ?? '' });
  }
  // Only extract left-hand variable names. Never parse or return example values.
  for (const filename of ['.env.example', '.env.sample', 'backend/.env.example', 'server/.env.example', 'api/.env.example', 'frontend/.env.example']) {
    const example = await file(repoDir, filename);
    if (example !== null) example.split(/\r?\n/).forEach((line, index) => {
      const name = /^\s*(?:export\s+)?([A-Z][A-Z0-9_]{0,99})\s*=/.exec(line)?.[1];
      if (name && !required.has(name)) required.set(name, { filename, line: index + 1, certain: false });
    });
  }
  let hasHttp = false, hasWorker = false, hasSqlite = false, hasDjangoModels = false;
  if (generatedServer && !settings.startCommand && backend?.kind === 'node') {
    const filename = at(backend.root, 'package.json');
    const raw = await file(repoDir, filename);
    if (raw) {
      const pkg = JSON.parse(raw), scriptName = backend.startScript ?? 'start';
      if (typeof pkg.scripts?.[scriptName] === 'string') sources.push({ filename, source: pkg.scripts[scriptName], checkHost: true, scriptLine: raw.slice(0, Math.max(0, raw.indexOf(JSON.stringify(scriptName)))).split('\n').length });
    }
  }
  for (const [name, command] of [['startCommand', settings.startCommand], ['releaseCommand', settings.releaseCommand], ['seedCommand', settings.seedCommand]] as const) if (command) sources.push({ filename: `<${name}>`, source: command });
  for (const { filename, source, scriptLine, checkHost } of sources) {
    if (/\b(?:express|fastify|koa|next|http-server|Flask|FastAPI|gunicorn|uvicorn)\b|\.listen\s*\(|createServer\s*\(/.test(source)) hasHttp = true;
    if (/\b(?:celery|bullmq|cron|rq)\b|node\s+\S*(?:worker|cron)/i.test(source)) hasWorker = true;
    if (/sqlite|db\.sqlite3/i.test(source)) hasSqlite = true;
    if (/models\.(?:Model|CharField)|django\.db/.test(source)) hasDjangoModels = true;
    source.split(/\r?\n/).forEach((line, index) => {
      const number = scriptLine ?? index + 1;
      if (/^\s*(?:#|\/\/)/.test(line)) return;
      if (!detection && !ownDockerfile && /^\s*(?:import\s+streamlit\b|from\s+streamlit\s+import\b)/.test(line)) {
        unsupportedFramework = 'Streamlit';
        const unknown = findings.find((f) => f.id === 'layout.unrecognized');
        if (unknown) {
          unknown.id = 'framework.streamlit';
          unknown.message = 'Streamlit was recognized, but has no generated build recipe in this version.';
          unknown.evidence = [{ file: filename, line: number }];
          unknown.fix = 'Provide a root Dockerfile running streamlit run with --server.address=0.0.0.0 and --server.port=$PORT. Local model inference still needs separate infrastructure.';
        }
      }
      // Do not return source snippets: even a default or example can be a secret.
      const envPattern = /process\.env(?:\.([A-Z][A-Z0-9_]{0,99})|\[\s*["']([A-Z][A-Z0-9_]{0,99})["']\s*\])|os\.environ\[\s*["']([A-Z][A-Z0-9_]{0,99})["']\s*\]|(?:os\.getenv|os\.environ\.get|\benv)\(\s*["']([A-Z][A-Z0-9_]{0,99})["']|import\.meta\.env\.([A-Z][A-Z0-9_]{0,99})/g;
      for (const match of line.matchAll(envPattern)) {
        const name = match[1] ?? match[2] ?? match[3] ?? match[4] ?? match[5];
        if (match[5] && ['MODE', 'DEV', 'PROD', 'BASE_URL', 'SSR'].includes(name)) continue;
        if (/^(?:VITE_|REACT_APP_|NEXT_PUBLIC_)/.test(name)) add('env.frontend-build', 'warning', `Frontend variable ${name} needs build-time configuration; project environment variables currently apply at runtime.`, filename, number, 'Provide public build configuration explicitly in your Dockerfile or safe frontend configuration. Never bake API secrets into browser bundles.');
        // An assignment configures the process; it is not a missing input.
        // Keep comparisons (==/===) and augmented assignments as reads.
        if ((match[1] || match[2] || match[3]) && /^\s*=(?!=)/.test(line.slice(match.index! + match[0].length))) continue;
        const certain = !!match[3] || filename.endsWith('.prisma') && !!match[4];
        const existing = required.get(name);
        if (!existing || certain) required.set(name, { filename, line: number, certain });
      }
      const port = /\.listen\s*\(\s*(\d{2,5})\b|app\.run\([^)]*\bport\s*=\s*(\d{2,5})|(?:--port(?:=|\s+)|--bind\s+[^\s:]+:)(\d{2,5})/.exec(line);
      const fixed = port && Number(port[1] ?? port[2] ?? port[3]);
      const readsPort = /process\.env(?:\.PORT|\[\s*["']PORT["'])|os\.(?:environ|getenv)[^\n]*["']PORT["']|\benv\(\s*["']PORT["']|\$(?:PORT\b|\{PORT\})/.test(source);
      if (fixed && !readsPort && (generatedServer || ownDockerfile || !!settings.startCommand)) {
        const expectedPort = fullstack ? settings.containerPort === 4000 ? 4001 : 4000 : settings.containerPort ?? 3000;
        const internalMatches = fullstack && fixed === expectedPort;
        const certain = generatedServer && !settings.startCommand || filename === '<startCommand>';
        if (!internalMatches) add('network.fixed-port', certain && fixed !== expectedPort ? 'blocker' : 'warning', `A fixed listening port (${fixed}) is used without reading PORT.`, filename, number, fullstack ? 'Read PORT in the backend; nginx uses a separate internal backend port.' : 'Read PORT in the server, or set the project port to the actual listener; review the bind address too.', fullstack ? undefined : { type: 'set-port', port: fixed });
      }
      if (/(?:listen\s*\([^\n]*|host\s*=\s*|--host\s+|--bind\s+)["']?(?:localhost|127\.0\.0\.1|::1)/.test(line) && !/\bHOST\b/.test(source)) {
        add('network.loopback', !fullstack && (generatedServer && !settings.startCommand || filename === '<startCommand>') ? 'blocker' : 'warning', 'A loopback-only bind address was found.', filename, number, fullstack ? 'Loopback is valid for an internal backend; confirm nginx proxies to that port.' : 'Bind the HTTP server to 0.0.0.0 and read HOST/PORT.');
      }
      if ((checkHost || filename === '<startCommand>' || filename === 'Dockerfile' && /^\s*(?:CMD|ENTRYPOINT)\b/.test(line)) && /\b(?:flask\s+run|uvicorn|vite(?:\s+preview)?)\b/.test(line) && !/--host|0\.0\.0\.0/.test(line)) add('network.default-host', 'warning', 'A development/default-host start command was found.', filename, number, 'Generated framework recipes use production servers; custom commands must specify 0.0.0.0 and PORT.');
      const serviceRules = [
        ['database', /postgres|psycopg|mysql|mongoose|mongodb|prisma/i, 'Provision an external database and configure its connection variables.'],
        ['redis', /ioredis|redis|bullmq|celery/i, 'Provision external Redis and configure its URL.'],
        ['object-storage', /@aws-sdk|boto3|\bs3\b/i, 'Provision object storage and configure its endpoint and credentials.'],
        ['payments', /\bstripe\b/i, 'Provide a Stripe account and credentials; DevFlow does not provision paid services.'],
        ['email', /nodemailer|\bsmtp\b/i, 'Provide an external email service and its credentials.'],
      ] as const;
      for (const [service, pattern, fix] of serviceRules) if (pattern.test(line) && !findings.some((f) => f.id === `service.${service}`)) add(`service.${service}`, 'warning', `External ${service} configuration may be needed.`, filename, number, fix);
      const modelPackage = '(?:torch|tensorflow|transformers|gpt4all|llama[-_]cpp(?:[-_]python)?)';
      const modelImport = new RegExp(`^\\s*(?:from\\s+${modelPackage}(?:\\.|\\s)|import\\s+${modelPackage}(?:\\s|,|$))`, 'i').test(line);
      const modelDependency = /(?:requirements\.txt|pyproject\.toml|package\.json)$/.test(filename) && new RegExp(`^\\s*["']?${modelPackage}(?=["'\\s\\[<=>!~;@,]|$)`, 'i').test(line);
      if (modelImport || modelDependency || /(?:^|\s)--gpus(?:=|\s)/.test(line)) add('layout.ml', 'blocker', 'Local ML/model inference dependencies are outside the supported 256 MB app resource model, even on CPU.', filename, number, 'Use a hosted inference API or infrastructure sized for the model; do not load the model inside this app container.');
      if (/\bmodel_path\s*=\s*["'][A-Za-z]:[\\/]/.test(line)) add('storage.model-path', 'blocker', 'A local model uses a Windows-only filesystem path unavailable inside the Linux app container.', filename, number, 'Move inference to an external service; a workstation model path cannot be mounted into deployed apps.');
      if (/multer|upload_to\s*=|MEDIA_ROOT|UPLOAD_DIR/.test(line)) add('storage.local-uploads', 'warning', 'Local upload storage may be lost when a container is replaced.', filename, number, 'Use external object storage; host mounts are not supported.');
    });
  }
  if (backend?.kind === 'python' && backend.framework === 'django') {
    required.set('DJANGO_SECRET_KEY', { filename: '<generated Django runtime>', line: 1, certain: true });
    add('django.proxy', 'info', 'The generated Django runtime applies allowed hosts, CSRF origins and trusted forwarded headers from environment.', '<generated Django runtime>', 1, 'Set DJANGO_ALLOWED_HOSTS and DJANGO_CSRF_TRUSTED_ORIGINS for your public domain.');
    if (hasDjangoModels && !settings.releaseCommand) add('database.migrations', 'warning', 'Django models were found without a release command.', 'manage.py', 1, 'For an external database set Release command to python manage.py migrate --noinput. One-off SQLite migrations cannot persist into a new app container.');
  }
  for (const [name, evidence] of required) if (!configured.has(name)) {
    const publicBuildVariable = /^(?:VITE_|REACT_APP_|NEXT_PUBLIC_)/.test(name);
    add(`env.missing.${name}`, evidence.certain ? 'blocker' : 'warning', `Environment variable ${name} is not configured.`, evidence.filename, evidence.line,
      publicBuildVariable ? `Configure ${name} as a public build-time value in your Dockerfile or frontend configuration. The runtime environment form does not inject it into browser bundles.` : `Add ${name} in project environment variables; optional/defaulted variables can be reviewed and left unset.`,
      publicBuildVariable ? undefined : { type: 'add-env', name });
  }
  for (const name of ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml']) {
    const compose = await file(repoDir, name);
    if (compose) {
      const section = /^services:\s*\n([\s\S]*?)(?=^\S|$(?![\s\S]))/m.exec(compose)?.[1] ?? '';
      const count = [...section.matchAll(/^  [\w-]+:\s*(?:#.*)?$/gm)].length;
      if (count > 1) add('layout.compose', ownDockerfile ? 'warning' : 'blocker', 'Compose declares multiple services; DevFlow starts one app container.', name, 1, 'Use external services and a self-contained app Dockerfile or supported single-app layout.');
    }
  }
  if (hasWorker && !hasHttp) add('layout.worker', 'blocker', 'A worker/cron workload has no recognized HTTP listener.', '.', 1, 'Deploy a supported HTTP service; background worker hosting is not supported.');
  if (await entry(repoDir, 'android') || await entry(repoDir, 'ios') || await entry(repoDir, 'pubspec.yaml')) add('layout.native', 'blocker', 'Native desktop/mobile layouts are not hosted by DevFlow.', '.', 1, 'Deploy a supported web frontend or backend separately.');
  if (hasSqlite || (await names(repoDir)).some((n) => /\.(?:sqlite3?|db)$/.test(n))) {
    add('storage.sqlite', 'warning', 'SQLite/local database data is container-local and resets on replacement.', '.', 1, 'Use an external database for durable data. Release/seed containers do not share local files with the serving app.');
    if ((settings.releaseCommand || settings.seedCommand) && !envNames.some((name) => /DATABASE|DB_HOST|DB_ENGINE|SQLALCHEMY|POSTGRES|MYSQL|MONGO/.test(name))) add('storage.release-local', 'blocker', 'Release/seed commands cannot initialize a persistent SQLite database for another container.', '<settings>', 1, 'Use an external database, or explicitly initialize disposable data in the app startup command.');
  }
  for (const directory of ['uploads', 'media', 'backend/uploads', 'backend/media', 'server/uploads']) if ((await entry(repoDir, directory))?.isDirectory()) { add('storage.upload-folder', 'warning', 'A local media/upload folder was found; runtime writes are not durable.', directory, 1, 'Immutable assets are fine. Store user uploads in external object storage.'); break; }
  if (ownDockerfile) {
    const dockerfile = await file(repoDir, 'Dockerfile') ?? '';
    if (!dockerfile.includes('devflow_ca') && /npm |pip |apk |apt-get|https:/i.test(dockerfile)) add('tls.custom-dockerfile', 'warning', 'Repository Dockerfiles manage their own HTTPS certificate trust.', 'Dockerfile', 1, 'On TLS-inspected networks use the devflow_ca build secret, or choose a generated preset.');
  }
  return summarize(findings, ownDockerfile ? 'Dockerfile' : detection?.stack ?? unsupportedFramework, rule);
}
export async function preflight(repoDir: string, settings: PreflightSettings, envNames: string[]): Promise<PreflightResult> {
  let selected: string;
  try { selected = await appRoot(repoDir, settings.rootDir); }
  catch { return summarize([{ id: 'layout.root-directory', severity: 'blocker', message: 'The selected root must be an existing folder inside the repository, without parent traversal or symlinks.', evidence: [{ file: '<settings>', line: 1 }], fix: 'Set Root directory to a repository folder such as frontend, or clear it to build the whole repository.' }], null, 'preflight'); }
  try {
    const result = await inspect(selected, settings, envNames);
    const root = normalizeRootDir(settings.rootDir);
    if (root !== '.') for (const finding of result.findings) for (const evidence of finding.evidence) {
      if (!evidence.file.startsWith('<')) evidence.file = evidence.file === '.' ? root : `${root}/${evidence.file.replace(/^\.\//, '')}`;
    }
    return result;
  }
  catch { return summarize([{ id: 'inspection.unsafe', severity: 'blocker', message: 'Files could not be inspected safely within the scan bounds.', evidence: [{ file: '.', line: 1 }], fix: 'Remove symlinks, oversized manifests or ambiguous layouts, then check again.' }], null, 'preflight'); }
}
