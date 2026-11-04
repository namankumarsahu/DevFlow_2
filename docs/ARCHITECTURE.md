# Architecture

## System diagram

```mermaid
flowchart LR
  U[Browser<br/>React + Tailwind] -->|REST /api| N[nginx]
  U -->|WebSocket /ws/logs| N
  N --> API[API<br/>Express + TS]
  GH[GitHub] -->|push webhook<br/>HMAC signed| API
  API -->|Prisma| PG[(PostgreSQL)]
  API -->|enqueue job| R[(Redis / BullMQ)]
  R -->|job| W[Worker<br/>BullMQ consumer]
  W -->|git clone| GH
  W -->|buildctl, private<br/>builds network| BK[Rootless BuildKit<br/>build sandbox]
  W -->|docker load / run<br/>via docker.sock| D[(Docker daemon)]
  D --> APP[User app containers<br/>CPU / RAM / pid / log limits]
  W -->|persist logs / status| PG
  W -->|PUBLISH logs:id| R
  R -->|SUBSCRIBE| API
  API -->|stream| U
```

## Deployment flow

```mermaid
sequenceDiagram
  participant UI
  participant API
  participant Q as Redis/BullMQ
  participant W as Worker
  participant D as Docker
  UI->>API: POST /projects/:id/deploy
  API->>API: create Deployment(QUEUED)
  API->>Q: add job (jobId = deploymentId)
  API-->>UI: 202 {id}
  UI->>API: WS /ws/logs?deploymentId=…
  Q->>W: job
  W->>W: acquire per-project lock
  W->>W: git clone --depth 1
  W->>W: select repo Dockerfile or detect and render .devflow/Dockerfile
  W->>D: rootless BuildKit build, then docker load
  W->>D: docker rm -f old; docker run new (env-file)
  W->>W: verify container is running
  W->>API: (via Redis pub/sub) log lines + status
  API-->>UI: live stream
```

## Key design decisions

| Decision | Why |
|---|---|
| API and worker are separate processes | Builds are CPU/IO heavy and long-running; API stays responsive, worker scales independently. |
| Logs are persisted **and** published | DB gives history for late joiners / refresh; Redis pub/sub gives low-latency live streaming across processes. |
| Rollback re-runs the stored image | Instant (no rebuild) and byte-identical to what was running before. Creates a new Deployment row linked via `rollbackOfId`, so history stays append-only. |
| Per-project Redis lock | Container name and host port are per-project; prevents two deploys racing. |
| Cancellation via Redis flag | Works across processes; the worker polls the key and `SIGKILL`s the active child process. Queued jobs are removed directly. |
| Env vars: AES-256-GCM, write-only API | Authenticated encryption; values are only decrypted in the worker and passed via a 0600 env-file deleted after start (never in `ps`/logs). |
| `authenticate` re-loads the user | Deleted users and role changes take effect immediately instead of when the JWT expires. |
| Strict input allow-lists for repo URL/branch | Values reach `git clone`; only `https://github.com/<owner>/<repo>` and safe branch names are accepted, and processes are spawned with arg arrays (no shell). |

## Database schema

```mermaid
erDiagram
  User ||--o{ Project : owns
  User ||--o{ Deployment : triggers
  Project ||--o{ EnvVar : has
  Project ||--o{ Deployment : has
  Deployment ||--o{ DeploymentLog : emits
  Deployment |o--o{ Deployment : "rollbackOf"

  User { uuid id PK; string email UK; string passwordHash; enum role }
  Project { uuid id PK; string name; string repoUrl; string branch; enum environment; int containerPort; int hostPort UK; string webhookSecret; uuid ownerId FK; uuid currentDeploymentId }
  EnvVar { uuid id PK; uuid projectId FK; string key; string valueEnc }
  Deployment { uuid id PK; uuid projectId FK; enum status; string commitHash; string imageTag; string url; int durationMs; uuid rollbackOfId FK; datetime startedAt; datetime finishedAt }
  DeploymentLog { int id PK; uuid deploymentId FK; string line; datetime createdAt }
```

Full definition: [`backend/prisma/schema.prisma`](../backend/prisma/schema.prisma).

## Auto-build strategies

Phase 2 adds bounded read-only preflight (support.ts/preflight.ts) and a cached
POST /projects/:id/preflight API. The dashboard requires a current check; the
worker re-inspects its fresh clone and stores the report on each deployment.
Only explicit admin overrides can bypass blockers, never sandbox or quota checks.
Foreground release/seed containers run before serving/traffic switch using the
unchanged app-run validator through a narrow entrypoint adapter. Outcomes and
failure classes feed the admin build-reliability endpoint. See
[SUPPORTED](SUPPORTED.md), [DATABASES](DATABASES.md) and
[CONTRIBUTING-RECIPES](CONTRIBUTING-RECIPES.md) for contracts and limitations.

`backend/src/lib/autobuild/` separates read-only detection, Dockerfile rendering,
and build selection from the worker's unchanged deployment runner. Detection
reads bounded files in the clone, refuses symlinks, and never imports repository
code, executes scripts, installs packages or contacts the network.

Selection order is explicit:

1. A project preset wins, including over a root Dockerfile. Ignoring that file is logged.
2. With no preset, an existing root Dockerfile is linted and used unchanged.
3. Without a root Dockerfile, AUTO tries `fullstack`, `node`, `python`, then `static`.
4. DOCKERFILE mode requires the root file and keeps the existing missing-file error.

The presets are STATIC, NODE, PYTHON_DJANGO, PYTHON_FLASK, PYTHON_FASTAPI and
FULLSTACK. The Python presets fix the server type rather than guessing it.
Start/build commands are limited to 1000 characters, reject control characters,
and enter JSON-array RUN/CMD instructions with JSON escaping. Commands are shell
programs **inside the build/app container**, never on the worker host.

Static sites use nginx-unprivileged with a runtime PORT template and SPA fallback.
Node uses npm/yarn/pnpm lockfiles and frozen installs, builds when a build script
exists, serves Vite/CRA output with nginx, and runs Next.js or a server start script.
Node 22/24 Alpine images form the allow-list; matching engines select a version,
otherwise Node 22 is used. Python uses Python 3.12 slim/alpine, pip, and a single
gunicorn/uvicorn worker bound to the runtime PORT. Django WSGI modules and
module-level Flask/FastAPI entry points are found by inspecting Python files.
Monorepos combine a Vite/CRA/static frontend with a Node or supported Python
backend, nginx API/WebSocket proxies, and a supervisor that exits on child death.
No recipe starts a database; application database URLs come from project env vars.

Generated Dockerfiles and their Dockerfile-specific ignore files are written to
`<clone>/.devflow/`, never the source repository. BuildKit's context stays the
clone while its `dockerfile` local points to `.devflow/`. The generated ignore
file appends mandatory exclusions after repository ignore rules, keeping .env,
.git, tests, host node_modules and private key files out of COPY operations.
This uses [Dockerfile-specific ignore-file precedence](https://docs.docker.com/build/concepts/context/#dockerignore-files).
Generated files receive the same linter, secret masking, build deadline, image
size checks, Docker run allow-list, health checks and quotas as supplied files.
Deployment rows persist the detected stack and rule, including for failed
detection. Existing projects default to AUTO; old deployments show “Not recorded”.
Apply the additive Prisma schema with the existing `prisma db push` startup flow.
The nullable legacy `Project.rootDir` column is preserved for existing databases;
auto-build selection in this version uses the repository root.

To add a strategy, implement `BuildStrategy<P>` from `types.ts`: return stack,
evidence and typed parameters from `detect(repoDir)`, then return a Dockerfile
from `render(detection, context)`. Add it to the priority-ordered registry. The
worker consumes the resulting plan, so no worker or deployment-runner rewrite
is needed. A future `BuildpackStrategy` can implement this same interface and
render a container recipe running the buildpack lifecycle **inside BuildKit**;
no buildpack detection or execution is implemented now.

Complex workspaces, Python factories, custom/native system dependencies,
unrecognized frontend output paths and multiple competing entry points need
explicit commands, a supported preset/layout, or a repository Dockerfile. When
no strategy matches, the error begins “Could not auto-detect this repository”,
lists supported stacks, and tells the user to pick a preset or add a Dockerfile.
Ambiguous layouts report the competing layout instead of silently guessing.

## Preview deployments (Step 14)

```mermaid
sequenceDiagram
  participant GH as GitHub
  participant API
  participant W as Worker
  participant C as Caddy
  GH->>API: pull_request (opened / synchronize), HMAC signed
  API->>API: upsert Preview(project, PR#), cancel older builds, enqueue Deployment(previewId)
  W->>W: lock:preview:<id>  (production deploys use lock:project:<id>, so they never wait on PRs)
  W->>GH: comment "building"  (only if a token is saved)
  W->>W: clone PR branch, sandboxed build, start container (label devflow.preview=<id>), health check
  W->>C: syncCaddy(): <slug>-pr<N>.<DOMAIN> -> new container
  W->>GH: edit the same comment with the URL
  GH->>API: pull_request closed
  API->>API: Preview.status = CLOSED, cancel running builds
  W->>W: wait for the preview lock, remove its containers, syncCaddy(), edit comment "removed"
```

| Decision | Why |
|---|---|
| Opt-in per project (`previewsEnabled`) | A preview runs code with the project's env vars; the owner decides. |
| Fork PRs are ignored | They would run untrusted code next to your secrets. Same-repo PRs come from people with write access. |
| Separate lock per preview | A PR build never blocks production, and two PRs build in parallel (worker concurrency permitting). |
| Containers labelled `devflow.preview` | Production cleanup after a deploy used to remove every container of the project; it now only removes non-preview ones (and vice versa). |
| One comment, edited in place | No comment spam on every push. A deleted comment is recreated. |
| `PREVIEW_MAX_PER_PROJECT` | Each preview is a running container; the oldest is retired when the cap is hit. |
| Routes come from the database | `syncCaddy()` adds every ACTIVE preview that has a live deployment, so a restart restores them. |
