import { at } from './files';
import { AppSpec, Detection, NodeApp, PythonApp, RenderContext, StaticApp } from './types';

export const validCommand = (value: string) => value.length <= 1000 && !/[\x00-\x1f\x7f-\x9f\u2028\u2029]/.test(value);
const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const run = (s: string) => `RUN ${JSON.stringify(['sh', '-ec', s])}`;
const cmd = (s: string) => `CMD ${JSON.stringify(['sh', '-ec', `export PORT="$PORT"; ${s}`])}`;
const copy = (sources: string[], destination: string, flags = '') => `COPY ${flags}${JSON.stringify([...sources, destination])}`;
const script = (filename: string, text: string) => run(`printf '%s\\n' ${text.split('\n').map(quote).join(' ')} > ${filename} && chmod 755 ${filename}`);
const trust = 'if [ -f /run/secrets/devflow_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/devflow_ca SSL_CERT_FILE=/run/secrets/devflow_ca PIP_CERT=/run/secrets/devflow_ca; fi; ';
const install = (s: string) => `RUN --mount=type=secret,id=devflow_ca ${JSON.stringify(['sh', '-ec', trust + s])}`;
const caBundle = install('cp /etc/ssl/certs/ca-certificates.crt /app/devflow-ca.pem; if [ -f /run/secrets/devflow_ca ]; then cat /run/secrets/devflow_ca >> /app/devflow-ca.pem; fi');
const home = 'ENV HOME=/tmp TMPDIR=/tmp PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1';
const nodeMemory = (ctx: RenderContext) => `ENV NODE_OPTIONS=--max-old-space-size=${Math.max(32, Math.min(96, Math.floor(ctx.limits.memoryMb * 0.4)))}`;

function packageSetup(n: NodeApp) {
  return n.manager === 'npm' ? '' : `(command -v corepack >/dev/null || npm install -g corepack --no-audit --no-fund) && corepack enable && corepack prepare ${n.managerVersion} --activate && `;
}
function nodeInstall(n: NodeApp, production: boolean) {
  const locked = n.manifests.length > 1;
  const command = n.manager === 'npm' ? `npm ${locked ? 'ci' : 'install'}${production ? ' --omit=dev' : ''} --no-audit --no-fund`
    : n.manager === 'pnpm' ? `pnpm install${locked ? ' --frozen-lockfile' : ''}${production ? ' --prod' : ''}`
      : `YARN_NODE_LINKER=node-modules yarn install${locked ? n.managerVersion.startsWith('yarn@1.') ? ' --frozen-lockfile' : ' --immutable' : ''}${production && n.managerVersion.startsWith('yarn@1.') ? ' --production' : ''}`;
  return install(packageSetup(n) + command);
}
function nodeBuild(n: NodeApp, override?: string | null) {
  return override ?? (n.hasBuild ? `${n.manager} run build` : null);
}
function nodeStart(n: NodeApp, override?: string | null) {
  if (override) return override;
  if (n.framework === 'next') return './node_modules/.bin/next start --hostname 0.0.0.0 --port "$PORT"';
  if (n.hasStart) return 'npm start';
  if (n.main) return `node -- ${quote(n.main)}`;
  throw new Error('Node app has no start script or main entry; set Start command in project settings or add a Dockerfile');
}
function workspace(n: NodeApp, stage: string, override?: string | null) {
  const build = nodeBuild(n, override);
  return [
    `FROM ${n.image} AS ${stage}`, 'WORKDIR /app',
    copy(n.manifests.map((f) => at(n.root, f)), './'), nodeInstall(n, !build),
    copy([n.root], './'), ...(build ? [run(build), run('rm -rf node_modules/.cache .next/cache')] : []),
  ];
}
function nginxTemplate(proxy: boolean) {
  return [
    'map $http_upgrade $connection_upgrade { default upgrade; "" close; }',
    'server {', '  listen 0.0.0.0:${PORT};', '  server_name _;',
    '  root /usr/share/nginx/html;', '  index index.html;', '  client_max_body_size 50m;',
    '  location / { try_files $uri $uri/ /index.html; }',
    ...(proxy ? [
      '  location ~ ^/(api|ws)(/|$) {',
      '    proxy_pass http://127.0.0.1:${DEVFLOW_BACKEND_PORT};',
      '    proxy_http_version 1.1;', '    proxy_set_header Host $host;',
      '    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;',
      '    proxy_set_header X-Forwarded-Proto $scheme;',
      '    proxy_set_header Upgrade $http_upgrade;', '    proxy_set_header Connection $connection_upgrade;',
      '    proxy_read_timeout 3600s;', '    proxy_buffering off;', '  }',
    ] : []), '}',
  ].join('\n');
}
function nginxSetup(proxy: boolean, ctx: RenderContext) {
  return [
    'USER root', 'WORKDIR /app', home, `ENV PORT=${ctx.port}`,
    script('/app/nginx.template', nginxTemplate(proxy)),
    run('mkdir -p /etc/nginx/conf.d && touch /etc/nginx/conf.d/default.conf && chown 101:101 /etc/nginx/conf.d/default.conf /app'),
  ];
}
const validatePort = 'case "$PORT" in ""|*[!0-9]*) echo "PORT must be numeric" >&2; exit 1;; esac\n(( PORT >= 1 && PORT <= 65535 ))';
const renderNginx = 'envsubst \'${PORT} ${DEVFLOW_BACKEND_PORT}\' < /app/nginx.template > /etc/nginx/conf.d/default.conf';
function staticImage(app: StaticApp | NodeApp, ctx: RenderContext) {
  const built = app.kind === 'node';
  if (built && !nodeBuild(app, ctx.buildCommand)) throw new Error('Frontend needs a build script or Build command in project settings');
  const lines = built ? workspace(app, 'frontend', ctx.buildCommand) : [];
  lines.push('FROM nginxinc/nginx-unprivileged:alpine', ...nginxSetup(false, ctx));
  lines.push(built ? copy([`/app/${app.output}`], '/usr/share/nginx/html', '--from=frontend ')
    : copy([at(app.root, app.output)], '/usr/share/nginx/html/'));
  const start = 'set -eu\ncase "$PORT" in ""|*[!0-9]*) exit 1;; esac\n[ "$PORT" -ge 1 ] && [ "$PORT" -le 65535 ]\n' + renderNginx + '\nexec nginx -g "daemon off; master_process off;"';
  lines.push(script('/app/start.sh', start), 'USER 101', `EXPOSE ${ctx.port}`, 'ENTRYPOINT ["/bin/sh", "/app/start.sh"]');
  return lines;
}

function pythonStart(app: PythonApp, override?: string | null) {
  if (override) return override;
  return app.server === 'uvicorn' ? `uvicorn ${app.target} --host 0.0.0.0 --port "$PORT" --workers 1`
    : `gunicorn ${app.target} --bind "0.0.0.0:$PORT" --workers 1 --threads 2 --worker-tmp-dir /tmp`;
}
function pythonDeps(app: PythonApp, destination: string) {
  const lines = [copy([at(app.root, app.manifest)], `${destination}/`)];
  if (app.manifest === 'pyproject.toml') lines.push(copy([app.root], `${destination}/`));
  lines.push(install(`python3 -m venv /app/venv && /app/venv/bin/pip install --no-cache-dir ${app.manifest === 'requirements.txt' ? '-r requirements.txt' : '.'} ${app.server}`));
  if (app.manifest !== 'pyproject.toml') lines.push(copy([app.root], `${destination}/`, '--chown=101:101 '));
  return lines;
}
function standalonePython(app: PythonApp, ctx: RenderContext) {
  return [
    'FROM python:3.12-slim', 'WORKDIR /app', home, `ENV PORT=${ctx.port} PATH=/app/venv/bin:$PATH NODE_EXTRA_CA_CERTS=/app/devflow-ca.pem SSL_CERT_FILE=/app/devflow-ca.pem`,
    caBundle, ...pythonDeps(app, '/app'), run('chown -R 101:101 /app'), 'USER 101', `EXPOSE ${ctx.port}`, cmd(pythonStart(app, ctx.startCommand)),
  ];
}
function standaloneNode(app: NodeApp, ctx: RenderContext) {
  const build = nodeBuild(app, ctx.buildCommand);
  const lines = build ? [...workspace(app, 'builder', ctx.buildCommand), `FROM ${app.image}`, 'WORKDIR /app', copy(['/app'], '/app', '--from=builder --chown=node:node ')]
    : [`FROM ${app.image}`, 'WORKDIR /app', copy(app.manifests.map((f) => at(app.root, f)), './'), nodeInstall(app, true), copy([app.root], './', '--chown=node:node ')];
  lines.push(home, `ENV NODE_ENV=production HOST=0.0.0.0 PORT=${ctx.port} NODE_EXTRA_CA_CERTS=/app/devflow-ca.pem`, nodeMemory(ctx), caBundle,
    run('chown -R node:node /app'), 'USER node', `EXPOSE ${ctx.port}`, cmd(nodeStart(app, ctx.startCommand)));
  return lines;
}
function fullstack(app: Extract<AppSpec, { kind: 'fullstack' }>, ctx: RenderContext) {
  const front = app.frontend, back = app.backend;
  const lines = front.kind === 'node' ? workspace(front, 'frontend', ctx.buildCommand) : [];
  if (front.kind === 'node' && !nodeBuild(front, ctx.buildCommand)) throw new Error('Frontend needs a build script or Build command in project settings');
  const backendBuild = back.kind === 'node' && back.hasBuild;
  if (back.kind === 'node' && backendBuild) lines.push(...workspace(back, 'backend'));
  lines.push(`FROM ${back.kind === 'node' ? back.image : 'python:3.12-alpine'}`, 'USER root', 'WORKDIR /app');
  lines.push(install('apk add --no-cache nginx bash gettext'), ...nginxSetup(true, ctx));
  // Alpine nginx's packaged main config assumes root-owned pid/temp paths. Use
  // a separate app config, without changing /etc/nginx/nginx.conf.
  lines.push(script('/app/nginx.conf', 'pid /tmp/nginx.pid;\nerror_log /dev/stderr;\nevents { worker_connections 256; }\nhttp {\n include /etc/nginx/mime.types;\n access_log /dev/stdout;\n client_body_temp_path /tmp/nginx-client;\n proxy_temp_path /tmp/nginx-proxy;\n fastcgi_temp_path /tmp/nginx-fastcgi;\n uwsgi_temp_path /tmp/nginx-uwsgi;\n scgi_temp_path /tmp/nginx-scgi;\n include /etc/nginx/conf.d/default.conf;\n}'));
  lines.push(caBundle, `ENV NODE_ENV=production HOST=0.0.0.0 NODE_EXTRA_CA_CERTS=/app/devflow-ca.pem SSL_CERT_FILE=/app/devflow-ca.pem PATH=/app/venv/bin:$PATH`, nodeMemory(ctx));
  lines.push(front.kind === 'node' ? copy([`/app/${front.output}`], '/usr/share/nginx/html', '--from=frontend ')
    : copy([at(front.root, front.output)], '/usr/share/nginx/html/'));
  lines.push('WORKDIR /app/backend');
  if (back.kind === 'python') lines.push(...pythonDeps(back, '/app/backend'));
  else if (backendBuild) lines.push(copy(['/app'], '/app/backend', '--from=backend --chown=101:101 '));
  else lines.push(copy(back.manifests.map((f) => at(back.root, f)), './'), nodeInstall(back, true), copy([back.root], './', '--chown=101:101 '));
  const backendCommand = back.kind === 'node' ? nodeStart(back, ctx.startCommand) : pythonStart(back, ctx.startCommand);
  const probe = back.kind === 'node' ? 'node -e \'const s=require("net").connect(Number(process.env.DEVFLOW_BACKEND_PORT),"127.0.0.1");s.on("connect",()=>{s.end();process.exit(0)});s.on("error",()=>process.exit(1));setTimeout(()=>process.exit(1),1000).unref()\''
    : 'python3 -c \'import socket,os;s=socket.create_connection(("127.0.0.1",int(os.environ["DEVFLOW_BACKEND_PORT"])),1);s.close()\'';
  const start = [
    '#!/bin/bash', 'set -Eeuo pipefail', validatePort,
    'export DEVFLOW_BACKEND_PORT=4000', '[[ "$PORT" != 4000 ]] || export DEVFLOW_BACKEND_PORT=4001',
    'pids=()', 'cleanup() { trap - EXIT TERM INT; for pid in "${pids[@]}"; do kill -TERM "$pid" 2>/dev/null || true; done; for pid in "${pids[@]}"; do wait "$pid" 2>/dev/null || true; done; }',
    'trap cleanup EXIT', 'trap "exit 143" TERM', 'trap "exit 130" INT', renderNginx,
    `PORT="$DEVFLOW_BACKEND_PORT" sh -ec ${quote(backendCommand)} &`, 'pids+=("$!")', 'ready=0',
    'for ((i=0; i<60; i++)); do', '  [[ " $(jobs -pr) " == *"${pids[0]}"* ]] || exit 1',
    `  if ${probe} 2>/dev/null; then ready=1; break; fi`, '  sleep 1', 'done',
    '[[ "$ready" == 1 ]] || { echo "Backend readiness timed out" >&2; exit 1; }',
    'nginx -e /dev/stderr -c /app/nginx.conf -g "daemon off; master_process off;" &', 'pids+=("$!")',
    'set +e', 'wait -n "${pids[@]}"', 'status=$?', '(( status != 0 )) || status=1', 'exit "$status"',
  ].join('\n');
  lines.push(run('chown -R 101:101 /app/backend'), script('/app/start.sh', start), 'USER 101', `EXPOSE ${ctx.port}`, 'ENTRYPOINT ["/bin/bash", "/app/start.sh"]');
  return lines;
}
export function render(detection: Detection, ctx: RenderContext): string {
  if (!Number.isInteger(ctx.port) || ctx.port < 1 || ctx.port > 65535) throw new Error('Invalid container port');
  for (const value of [ctx.startCommand, ctx.buildCommand]) if (value != null && (!validCommand(value) || !value.trim())) throw new Error('Commands must be 1–1000 characters without newlines or control characters');
  const app = detection.parameters;
  const lines = app.kind === 'fullstack' ? fullstack(app, ctx) : app.kind === 'static' ? staticImage(app, ctx)
    : app.kind === 'python' ? standalonePython(app, ctx) : ['vite', 'cra'].includes(app.framework) ? staticImage(app, ctx) : standaloneNode(app, ctx);
  return '# Generated by DevFlow. Repository files are unchanged.\n' + lines.join('\n') + '\n';
}
