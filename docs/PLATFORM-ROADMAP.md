# Platform foundation audit and release plan

## Verified starting point

DevFlow already has bounded clones, pure detection/preflight, rootless BuildKit,
resource/argument policies, quotas, release containers, HTTP readiness, blue/green
routing, rollback, regression fixtures and deployment failure classes. Existing
root-directory, environment-write and local-model regressions remain covered.

The planning gap was that preflight and execution exposed different information:
the worker detected/rendered again and the UI did not identify the revision,
commands, effective limits or frontend-only scope that would actually run.
An HTTP success also does not verify contacts, registration, OCR or a database.

## Foundation release 1: reviewed deployment plans

The API and worker use analyzeDeployment and a versioned, serializable plan. The
plan describes revision, root, rule, evidence, components, shared recipe commands,
public/internal ports, health path, limits, release/seed and missing env names.
The resolved Dockerfile is materialized by the worker without re-rendering it.
Plans are persisted in existing Project.preflight and Deployment.preflight JSON;
this release requires no database migration or data rewrite.

The dashboard submits its reviewed plan ID. The API checks it before consuming
an attempt; the worker compares against the fresh clone and effective policy
before any build. A changed revision/recipe/configuration requires a new review.
This check is independent of the admin blocker override. API/webhook clients
without a reviewed ID retain the existing fresh-worker-check behavior.

Only env names and a recipe digest contribute to public identity; Dockerfile
contents, real .env files and secret values are not returned in the plan.
Runtime PORT is owned by the reviewed project setting. A project's PORT env
entry cannot silently move the listener away from its health-check port.

Acceptance gates: existing tests, plan identity/materialization tests, API stale
review rejection before quota consumption, worker drift rejection before BuildKit,
backend/frontend builds, and a local sandboxed deployment with a reviewed ID.

## Remaining work in phase 1

- A strict versioned repository configuration schema with documented precedence.
- Explicit entry-point choices for ambiguous layouts, rather than generic advice.
- Richer per-service environment and external service dependency modeling.
- Distinguish requested and applied plan history in the deployment UI.

## Following releases

2. Compatibility corpus: full applications for each advertised framework, exact
version/layout coverage, production startup adapters and real browser workflows.
Evaluate maintained build tooling with sandbox/reproducibility proof first.

3. Builds: isolated dependency caching, bounded transient retries, stage timings
and actionable network/compile/startup failure classification. Keep the overall
deadline and tenant isolation; never cache credentials or relax TLS verification.

4. Service groups: independent frontend, API, worker and scheduled-job lifecycle,
safe networking, per-service readiness and correct browser API configuration.

5. Data services: external connection workflow first, then separately reviewed
managed database/storage provisioning, tenant isolation, backups and restore tests.

6. Operations: ongoing health, metrics, safe capacity scheduling, audit events,
resource plans and documented recovery drills.

7. Release gates: real application workflows and honest first-attempt reliability
metrics. HTTP readiness must never be advertised as full application correctness.

The current release does not add managed databases, persistent app volumes,
additional framework support or guaranteed arbitrary-repository deployments.

## Verification of foundation release 1

- 295 backend tests across 20 suites passed, including all earlier regressions.
- Fixture checks, backend compilation and dashboard production build passed.
- The live API rejected an incorrect reviewed plan ID with HTTP 409.
- A reviewed frontend-only plan deployed through rootless BuildKit in 16.8 s;
  its recorded execution identity matched the preflight review identity.
- Browser automation could not attach, so visual browser verification remains
  untested. This was an HTTP deployment check, not a business-workflow test.
