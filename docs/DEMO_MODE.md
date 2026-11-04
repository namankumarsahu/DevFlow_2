# Public recruiter demo mode

`DEMO_MODE=true` (the default in `docker-compose.yml`) lets strangers register and deploy their own apps without being able to exhaust the server. It applies to accounts with role `USER`. Admins are the operators and are exempt from the quotas (they can also see and manage every project).

## Limits

| Rule | Default | Setting |
|---|---|---|
| Active applications per user (queued + building + deploying + running) | 2 | `DEMO_MAX_ACTIVE_APPS` |
| Deployment attempts per user per rolling hour (deploy, redeploy, rollback, webhook push; failed ones count) | 5 | `DEMO_MAX_DEPLOYS_PER_HOUR` |
| Concurrent builds per user | 1 | fixed |
| Whole deployment time budget | 5 min | `DEPLOY_TIMEOUT_MS` |
| Projects per account | 5 | `DEMO_MAX_PROJECTS` |
| Environment variables per project | 30 | `DEMO_MAX_ENV_VARS` |
| Memory / CPU per app | 256 MB, no swap / 0.25 core | `DEFAULT_*`, `MAX_*` |
| Disk per app | 512 MB **only if docker can enforce it**, otherwise informational | `DEFAULT_DISK_MB`, `STORAGE_QUOTA` |
| Built image size | 1024 MB | `MAX_IMAGE_MB` |
| Deployment log | 5000 lines / 1 MB / 2000 chars per line | `MAX_LOG_*` |
| Sign-up | optional invite code, 50 accounts, 5 per IP per hour | `REGISTRATION_INVITE_CODE`, `DEMO_MAX_USERS`, `REGISTER_PER_IP_HOUR` |

Pull-request previews are off for users (each preview is another running container).

**What frees a slot:** deleting the project. A project whose deployments only failed or were cancelled holds no slot. Redeploying or rolling back an app that already holds a slot never needs a second one.

## How it is enforced

```
POST /projects/:id/deploy | POST /deployments/:id/rollback | GitHub push webhook
        -> requestDeployment()                     services/deployments.ts
             BEGIN
               SELECT ... FROM "User" WHERE id = <project owner> FOR UPDATE   <- serialises this user's requests
               count active apps / in-flight builds / attempts in the last hour
               reject: 403 ACTIVE_APP_QUOTA_REACHED | 409 BUILD_IN_PROGRESS | 429 DEPLOY_RATE_LIMITED (+ Retry-After)
               INSERT DeploymentAttempt, INSERT Deployment (QUEUED)
             COMMIT
        -> BullMQ job -> worker
```

* The quota belongs to the project **owner**, whoever triggers it. The check and the insert are one transaction behind a row lock, so simultaneous requests cannot exceed the limits.
* Attempts live in their own table (`DeploymentAttempt`), so deleting and recreating a project does not reset the hourly count. A project cannot be deleted while a build is running.
* The worker re-validates everything it was given. Resource values stored on a project are only a request: `effectiveLimits()` clamps them to the administrator's maximum on every deploy, so rows from before demo mode (512 MB) or hand-edited rows cannot exceed it. The values really applied are stored on the deployment and shown in the dashboard.
* `docker run` arguments are checked against an allow-list (`lib/dockerSafety.ts`) right before execution: no `--privileged`, mounts, host networking/PID, extra capabilities or Docker socket.

### Applying new limits to running apps
Containers keep the limits they started with. The dashboard shows "Redeploy to apply". An admin can call `POST /api/admin/redeploy-out-of-policy`, which re-runs each live app's current image with the new limits through the normal blue/green path (new container must pass its health check; the old one keeps serving otherwise). It does not rebuild from git and does not use up users' attempts.

## Build and queue protection

* **Deadline:** one budget per deployment (`DEPLOY_TIMEOUT_MS`, 5 min in demo mode) covering clone, build, image load, start and health check. Each child process runs in its own process group; on timeout or cancel the whole group is killed (`lib/runProcess.ts`), the half-started container is removed, and the clone, env-file (secrets) and image tarball are deleted (`lib/deployCleanup.ts`).
* **Lost workers:** a reaper (every minute) fails deployments stuck past the deadline, removes their container and sweeps old temp files, so a crashed worker cannot hold a user's build slot or quota.
* **Dockerfile:** rejected before building if it names a custom `# syntax=` frontend (only `docker/dockerfile` is allowed), uses `--security=insecure` / `--network=host`, is a symlink, or is over 100 KB. This is defence in depth; the boundary is the rootless BuildKit sandbox.
* **Image:** the export is size-watched while it is written; after loading, images over `MAX_IMAGE_MB` or declaring `VOLUME` (which would bypass disk limits) are rejected and removed.
* **Logs:** capped in lines, bytes and line length; known env values, GitHub/AWS tokens and URL credentials are masked before storage.
* **Worker lock:** builds of one user are also serialised in the worker (`lock:user-build:<id>`).

## What is enforced, what is not

Verified by the automated tests in this repository (Jest + Supertest, in-memory database, no Docker):

* active-app quota, redeploy/rollback not consuming a slot, failed/deleted apps not counted, in-flight states counted
* one in-flight deployment per user; hourly attempt limit with `Retry-After`; not resettable by deleting a project
* behaviour under concurrent requests (with a control experiment showing the race exists without the lock)
* ownership isolation on every project/deployment/env/token route; secrets never returned
* limit validation and server-side clamping; `docker run` allow-list; demo sign-up controls
* timeout / cancel / size-cap kill real process groups; cleanup after failed, timed-out and cancelled jobs; reaper

**Not verified here** (needs a real host with Docker; I could not run Docker or PostgreSQL where this was written):

* the row lock on real PostgreSQL (standard `FOR UPDATE` semantics, but only simulated in the tests)
* the full worker pipeline against Docker/BuildKit, including that BuildKit stops a build when `buildctl` is killed
* the disk-quota probe (`docker run --storage-opt`), image inspection and `docker rmi` paths

**Not enforced / known gaps:**

* **Disk per app is not enforced** on a normal ext4 host. The setting is shown as informational. It is only reported as enforced when `STORAGE_QUOTA=true` **and** the worker's startup probe proved docker accepts `--storage-opt`.
* **Build CPU/memory/disk are limits on the shared BuildKit container** (`BUILDKIT_MEM`, `BUILDKIT_CPUS`, cache GC target), not per build or per user. The BuildKit volume has no hard size cap while a build runs.
* **The worker mounts `/var/run/docker.sock`** (root-equivalent on the host). User containers never get it, but a bug in the worker would. A socket proxy or a runner VM is the real fix.
* **Apps share the `devflow_apps` network** and can reach each other; app containers share the host kernel (no gVisor/Firecracker); BuildKit's cache is shared between users.
* Outbound traffic from apps/builds is unrestricted (apart from the metadata block in `scripts/block-metadata.sh`, which you must run on EC2).
* The account cap is soft (two sign-ups at the limit can overshoot by a few); per-IP limits depend on `TRUST_PROXY` being right.
* While a redeploy drains, an app briefly runs twice, so peak memory is up to 2x the steady figure.

**Do not describe this as production-grade multi-tenant isolation.** It limits accidental and casual abuse of a small demo server; untrusted code still shares a kernel with the host.
