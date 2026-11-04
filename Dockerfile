# Place this file in the extracted devflow/ repository root, then docker build .
# The ZIP is not a build context: backend/ and frontend/ must exist beside this file.
# No worker: deployment jobs cannot execute in this demo-lite image.
FROM node:22-alpine AS frontend
WORKDIR /build/frontend
COPY frontend/package*.json ./
RUN npm ci --no-audit --no-fund
# Explicit allow-list avoids host node_modules, tests, caches and .env files.
COPY frontend/index.html frontend/tsconfig.json frontend/vite.config.ts frontend/tailwind.config.js frontend/postcss.config.js ./
COPY frontend/src ./src
RUN npm run build

FROM node:22-alpine AS backend
RUN apk add --no-cache openssl
WORKDIR /build/backend
COPY backend/package*.json ./
COPY backend/prisma ./prisma
RUN npm ci --no-audit --no-fund
COPY backend/tsconfig.json ./
COPY backend/src ./src
RUN npm run build

FROM nginxinc/nginx-unprivileged:alpine AS runtime-base
USER root
RUN apk add --no-cache nodejs openssl postgresql redis bash \
    && mkdir -p /app /data/pgdata /data/redis /data/run /data/tmp \
    && chown -R 101:101 /app /data
# Keep the upstream nginx.conf, including its unprivileged /tmp pid/temp paths.
# /tmp is writable by UID 101; all other runtime state lives under /data.
RUN printf '%s\n' \
    'map $http_upgrade $connection_upgrade {' \
    '    default upgrade;' \
    '    "" close;' \
    '}' \
    'server {' \
    '    listen 0.0.0.0:3000;' \
    '    server_name _;' \
    '    root /usr/share/nginx/html;' \
    '    index index.html;' \
    '    client_max_body_size 1m;' \
    '    client_body_temp_path /data/tmp/client;' \
    '    proxy_temp_path /data/tmp/proxy;' \
    '    location / { try_files $uri $uri/ /index.html; }' \
    '    location /api/ {' \
    '        proxy_pass http://127.0.0.1:4000;' \
    '        proxy_http_version 1.1;' \
    '        proxy_set_header Host $host;' \
    '        proxy_set_header X-Real-IP $remote_addr;' \
    '        proxy_set_header X-Forwarded-For $remote_addr;' \
    '        proxy_set_header X-Forwarded-Proto $scheme;' \
    '        proxy_set_header Upgrade $http_upgrade;' \
    '        proxy_set_header Connection $connection_upgrade;' \
    '    }' \
    '    location /ws/ {' \
    '        proxy_pass http://127.0.0.1:4000;' \
    '        proxy_http_version 1.1;' \
    '        proxy_set_header Host $host;' \
    '        proxy_set_header X-Forwarded-For $remote_addr;' \
    '        proxy_set_header X-Forwarded-Proto $scheme;' \
    '        proxy_set_header Upgrade $http_upgrade;' \
    '        proxy_set_header Connection $connection_upgrade;' \
    '        proxy_read_timeout 3600s;' \
    '        proxy_buffering off;' \
    '    }' \
    '}' > /etc/nginx/conf.d/default.conf
USER 101
ENV NODE_ENV=production PORT=4000 DEMO_MODE=true \
    DATABASE_URL="postgresql://devflow@127.0.0.1:5432/devflow?connection_limit=3&pool_timeout=20" \
    REDIS_URL="redis://127.0.0.1:6379" CORS_ORIGIN="*" TRUST_PROXY=1 \
    NODE_OPTIONS="--max-old-space-size=96" UV_THREADPOOL_SIZE=1 \
    PGDATA=/data/pgdata TMPDIR=/data/tmp HOME=/data
WORKDIR /app

# Initialize and create the schema as UID 101 during build, never on startup.
# Trust authentication is restricted to loopback inside this single container.
FROM runtime-base AS database
COPY --from=backend --chown=101:101 /build/backend/node_modules ./node_modules
COPY --from=backend --chown=101:101 /build/backend/prisma ./prisma
RUN initdb -D "$PGDATA" -U devflow --encoding=UTF8 --locale=C --auth-local=trust --auth-host=trust \
    && printf '%s\n' \
       "listen_addresses = '127.0.0.1'" \
       "unix_socket_directories = '/data/run'" \
       'shared_buffers = 16MB' \
       'max_connections = 20' \
       'work_mem = 1MB' \
       'maintenance_work_mem = 8MB' \
       'wal_buffers = 1MB' \
       'max_wal_size = 64MB' \
       'min_wal_size = 32MB' \
       'max_worker_processes = 0' \
       'max_parallel_workers = 0' \
       'max_parallel_workers_per_gather = 0' \
       'autovacuum_max_workers = 1' \
       'autovacuum_work_mem = 8MB' \
       'jit = off' >> "$PGDATA/postgresql.conf" \
    && pg_ctl -D "$PGDATA" -l /data/init.log -w start \
    && trap 'pg_ctl -D "$PGDATA" -m fast -w stop' EXIT \
    && createdb -h 127.0.0.1 -U devflow devflow \
    && NODE_OPTIONS=--max-old-space-size=256 node node_modules/prisma/build/index.js db push --skip-generate \
    && pg_ctl -D "$PGDATA" -m fast -w stop \
    && trap - EXIT

FROM backend AS production-deps
RUN npm prune --omit=dev --ignore-scripts --no-audit --no-fund \
    && find node_modules -type d \( -name test -o -name tests -o -name __tests__ -o -name .cache \) -prune -exec rm -rf '{}' + \
    && find node_modules -type f \( -name '*.ts' -o -name '*.map' \) -delete

FROM runtime-base AS final
COPY --from=frontend /build/frontend/dist /usr/share/nginx/html
COPY --from=backend --chown=101:101 /build/backend/dist ./dist
COPY --from=production-deps --chown=101:101 /build/backend/node_modules ./node_modules
COPY --from=database --chown=101:101 /data/pgdata /data/pgdata
USER root
RUN printf '%s\n' \
    '#!/bin/bash' \
    'set -Eeuo pipefail' \
    'umask 077' \
    'pids=()' \
    'cleanup() {' \
    '  trap - EXIT TERM INT' \
    '  for pid in "${pids[@]}"; do kill -TERM "$pid" 2>/dev/null || true; done' \
    '  for pid in "${pids[@]}"; do wait "$pid" 2>/dev/null || true; done' \
    '}' \
    'trap cleanup EXIT' \
    'trap "exit 143" TERM' \
    'trap "exit 130" INT' \
    'mkdir -p /data/redis /data/run /data/tmp' \
    '[[ -s "$PGDATA/PG_VERSION" ]] || { echo "Missing preinitialized database; use a writable /data volume seeded from this image." >&2; exit 1; }' \
    'if [[ ! -f /data/secrets ]]; then' \
    '  secrets_tmp=$(mktemp /data/secrets.XXXXXX)' \
    '  jwt_secret=$(openssl rand -hex 32)' \
    '  encryption_key=$(openssl rand -hex 32)' \
    '  printf "JWT_SECRET=%s\nENCRYPTION_KEY=%s\n" "$jwt_secret" "$encryption_key" > "$secrets_tmp"' \
    '  mv "$secrets_tmp" /data/secrets' \
    'fi' \
    'set -a' \
    'source /data/secrets' \
    'set +a' \
    'redis-server --bind 127.0.0.1 --port 6379 --dir /data/redis --maxmemory 32mb --maxmemory-policy noeviction --save "" --appendonly yes --appendfsync everysec --auto-aof-rewrite-percentage 0 --daemonize no &' \
    'pids+=("$!")' \
    'postgres -D "$PGDATA" &' \
    'pids+=("$!")' \
    'check_children() {' \
    '  local pid live' \
    '  live=" $(jobs -pr | tr "\n" " ") "' \
    '  for pid in "${pids[@]}"; do' \
    '    [[ "$live" == *" $pid "* ]] || { echo "Service $pid exited" >&2; exit 1; }' \
    '  done' \
    '}' \
    'ready=0' \
    'for ((i=0; i<60; i++)); do' \
    '  check_children' \
    '  if redis-cli -h 127.0.0.1 ping | grep -qx PONG && pg_isready -h 127.0.0.1 -U devflow -d devflow >/dev/null; then ready=1; break; fi' \
    '  sleep 1' \
    'done' \
    '[[ "$ready" == 1 ]] || { echo "Database readiness timed out" >&2; exit 1; }' \
    'node dist/server.js &' \
    'pids+=("$!")' \
    'ready=0' \
    'for ((i=0; i<60; i++)); do' \
    '  check_children' \
    '  if wget -q -O /dev/null http://127.0.0.1:4000/api/health; then ready=1; break; fi' \
    '  sleep 1' \
    'done' \
    '[[ "$ready" == 1 ]] || { echo "API readiness timed out" >&2; exit 1; }' \
    'nginx -g "daemon off; master_process off;" &' \
    'pids+=("$!")' \
    'set +e' \
    'wait -n "${pids[@]}"' \
    'status=$?' \
    'set -e' \
    '(( status != 0 )) || status=1' \
    'exit "$status"' \
    > /app/start.sh && chmod 755 /app/start.sh
USER 101
# Docker seeds new volumes from the build-time database. Restart the same container
# to retain data and keys. Removing it with --rm also removes its anonymous volume;
# use a named volume on /data when persistence across replacement is needed.
VOLUME ["/data"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=120s --retries=3 \
    CMD wget -q -O /dev/null http://127.0.0.1:3000/ || exit 1
ENTRYPOINT ["/bin/bash", "/app/start.sh"]
