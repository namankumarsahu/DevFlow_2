# Official support matrix

The authoritative machine-readable matrix is
[`support.ts`](../backend/src/lib/autobuild/support.ts), also available at
`GET /api/projects/support` to authenticated users. Support describes an HTTP
deployment layout within the existing build/time/image/runtime limits. It is
not a guarantee that arbitrary code, credentials or business features work.

| Stack | Supported layout |
| --- | --- |
| Static | Root index.html or dist/build/public/out output |
| Node HTTP | npm/yarn/pnpm; Express/Nest or another HTTP start script; Vite/CRA static builds; Next.js production start |
| Python | requirements.txt or pip-installable pyproject.toml; Django WSGI, module-level Flask or FastAPI; gunicorn/uvicorn |
| Frontend + backend | Exactly one frontend/client/web and one backend/server/api; Vite/CRA/static frontend with supported Node/Python backend |
| Own Dockerfile | One self-contained HTTP image; repository file stays unchanged unless a preset is explicitly selected |

Root directory selects the app folder for both preflight and the build context.
Leave it blank to detect the whole repository, including frontend/backend pairs.
Set it to `frontend` to deploy only that folder; a sibling backend is excluded.
Dockerfile precedence applies within the selected directory. Relative paths must
exist inside the clone and cannot traverse parents or symlinks.

Optional versioned [repository configuration](REPOSITORY-CONFIGURATION.md) supplies
defaults. Explicit dashboard settings take precedence; the review identifies the
configuration source. Ambiguous layouts offer bounded folder/Python entry-point
choices. Recorded plans retain reviewed and resolved identities for comparison.

See [build reliability](BUILD-RELIABILITY.md) for production script selection,
workspace limitations, network retries, frontend build variables and per-project
readiness checks. These are bounded compatibility rules, not support for every
repository using a named framework.

Each preflight result includes a status and reason:

- `supported`: a recognized layout with no known warnings or blockers.
- `supported-with-warnings`: a supported layout requiring manual review, such
  as optional/defaulted configuration, external services or ephemeral storage.
- `unsupported`: a blocking requirement or unsupported layout must be resolved.

Not automatically supported: Compose multi-service deployments, unconfigured
credentials or paid services, GPU/ML workloads, custom infrastructure, native
desktop/mobile apps, and workers/cron without HTTP. DevFlow does not create
databases, paid accounts, buckets or credentials. Apps needing external services
can be hosted after the owner provisions and configures them; preflight can
verify names, never whether credentials actually work.

Streamlit is recognized but has no generated recipe yet; provide a root Dockerfile
that binds its production server to 0.0.0.0 and PORT. This does not make local LLM
inference supported. GPT4All/llama.cpp models loaded on CPU still exceed the
256 MB app budget; use external inference APIs instead. Comments mentioning
CUDA and assignments to environment variables are not deployment requirements.

Checks inspect at most 4 MB of source (256 KB per file) and report file/line evidence without source
snippets or secret values. Fixed ports and explicit loopback binds are blockers
when certain for a generated standalone Node server. Framework-controlled
binds, defaults and custom Dockerfile behavior are heuristic warnings. Strict
`os.environ[...]`, Prisma env requirements and the generated Django secret are
blockers when missing; optional/defaulted names are warnings. Dynamic variable
names, arbitrary application logic and startup success still need runtime checks.

Requirements run when a project is opened/created or saved settings/environment
change. Deploy remains disabled until a check completes and blockers are fixed.
Only an authenticated administrator can explicitly override blockers; the same
quotas, Docker policies, caps and health checks still apply. API clients should
POST `/api/projects/:id/preflight` before posting Deploy. Known cached blockers
are rejected before an attempt is recorded. Clients without a prior report are
still checked by the worker before any build; those attempts can be classified
as preflight-blocked. The worker always rechecks the actual fresh clone.

Checks are cached for five minutes by repository/branch, settings and configured
variable names. Force Check again after a source push. A concurrent settings
change invalidates a check. Clone work is shallow, size-watched, time-bounded,
limited to two checks globally and one per owner, and cleaned up afterward.

Generated images install CA certificates and accept the public `devflow_ca`
bundle for TLS-inspected networks. Own Dockerfiles must opt into that secret
themselves. App source files are never patched. Next uses production next start;
Vite/CRA are served statically. Python wrappers and the optional Express/Nest
preload trust forwarded headers only from loopback and the platform-resolved
Caddy addresses. Explicit application proxy configuration can override defaults.

Django uses a generated settings module. Set `DJANGO_SECRET_KEY` and, for a
custom domain, `DJANGO_ALLOWED_HOSTS` and `DJANGO_CSRF_TRUSTED_ORIGINS` (comma
separated). The worker supplies the application URL. DEBUG defaults false.
When the app defines STATIC_ROOT, collectstatic runs into an app-writable managed
directory and WhiteNoise serves it. Missing custom native OS dependencies,
factory-only entry points and complex workspace configurations need an explicit
Dockerfile. Custom start commands must preserve the bind/startup requirements.

See [databases and storage](DATABASES.md) and
[recipe regression workflow](CONTRIBUTING-RECIPES.md).
