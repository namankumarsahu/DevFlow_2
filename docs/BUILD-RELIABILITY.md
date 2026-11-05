# Build compatibility and reliability

Generic Node applications prefer a declared start:prod script over start. A
dashboard start command still takes precedence. Next.js can use its framework
build/start commands when package scripts are absent. Generated Yarn builds
use node_modules consistently, including when a repository requests PnP.

Workspace layouts and workspace: dependencies need an explicit supported app
selection or a repository Dockerfile. DevFlow does not guess a multi-service
topology. Selecting an app does not automatically include sibling services.

Generated npm installs use bounded registry request retries and 30-second
request timeouts. Only network requests retry; DevFlow does not repeat arbitrary
build scripts after failure. Existing Docker layer reuse remains available.
Shared writable package caches are not introduced across untrusted projects.

Public frontend variables are reported as build-time requirements. Runtime
environment values are not injected into browser builds. Never put secrets in
VITE_, NEXT_PUBLIC_ or REACT_APP_ variables; these values can become public.

Projects can choose a local health path in dashboard settings or devflow.json.
Explicit readiness paths must return 2xx consecutively before traffic switches.
External service credentials and application workflows still require their own
validation. Successful HTTP checks alone do not prove application correctness.

Regression fixtures cover production-only Node scripts, Next.js without scripts,
Yarn/Pnpm builds and an API with a non-root readiness endpoint. Docker fixture
checks use 256 MB, 0.25 CPU, non-root containers and an alternate PORT.
