# Repository deployment configuration

Add one `devflow.json` at the Git repository root. It is optional and versioned:

```json
{
  "version": 1,
  "rootDir": "backend",
  "preset": "PYTHON_FASTAPI",
  "entrypoint": "main:app",
  "releaseCommand": "python migrate.py"
}
```

The authoritative validator is backend/src/lib/autobuild/configuration.ts.
The file must be a regular file of at most 16 KB. Unknown fields, unsupported
versions, invalid JSON, symlinks, absolute/parent paths and command control
characters are rejected without returning configuration values or parser snippets.

Allowed fields:

| Field | Meaning |
| --- | --- |
| version | Required, exactly 1 |
| rootDir | Relative app directory, or null; . selects the entire repository |
| buildMode | AUTO or DOCKERFILE |
| preset | STATIC, NODE, PYTHON_DJANGO, PYTHON_FLASK, PYTHON_FASTAPI, FULLSTACK, or null |
| entrypoint | Detected module-level Python module:application, or null |
| buildCommand, startCommand | Optional nonempty commands, at most 1000 characters, or null |
| releaseCommand, seedCommand | Optional one-off runtime commands under existing policy, or null |

Environment values, resources, ports, mounts, networking and privileges cannot
be requested by repository configuration. Use dashboard environment variables
for secrets. Keep credentials out of command text and committed files.

## Precedence and review

1. Explicit non-null dashboard values override matching repository defaults.
2. Null/unset dashboard fields inherit repository defaults.
3. Remaining fields use the existing framework defaults and detection rules.

Explicit dashboard DOCKERFILE mode selects a Dockerfile even if repository
defaults specify a framework preset. An explicit dashboard preset can override
that mode as before. Clear incompatible Python entry points when selecting a
different framework.

Disable **Use devflow.json defaults** to ignore the file entirely and use
dashboard settings plus automatic detection. This also provides an explicit way
to clear repository defaults. Use root directory . to override a configured root
while retaining other defaults.

The review panel identifies the source file and overridden field names. Both
preflight and the worker resolve identical settings from their cloned revision.
Release/seed commands from configuration run only inside the constrained app
image, never on the worker host. All existing sandbox and image checks apply.

## Ambiguous applications

Requirements offers up to eight detected application choices from bounded root,
apps/* and services/* folders, and recognized Python entry points. It never
imports their modules or executes application code.

Choosing an application explicitly disables repository defaults for that project
and updates dashboard root/preset/entrypoint. Review commands afterward. A
frontend-only choice excludes sibling APIs and databases; a successful frontend
HTTP response does not verify the application workflow.

Python choices currently recognize module-level Flask/FastAPI objects and
Django WSGI modules. Dynamic factories and custom entry-point patterns may need
a repository Dockerfile. Invalid selections stay blocked before a build.

Recorded deployment plans show the resolved revision, scope, commands, limits
and reviewed/resolved IDs. Old records without plans are labeled as such. A
failed build's recorded plan is not evidence that the application ran.

## Additive database update

Back up PostgreSQL, then apply prisma/changes/20261105_repository_configuration.sql
with psql ON_ERROR_STOP enabled before deploying the regenerated client. The
script adds only nullable entrypoint and useRepositoryConfig defaulting true.
It neither rewrites existing roots nor resets tables. Existing API versions can
continue running while the columns are added. No accept-data-loss flag is used.

Keep the additive columns during application rollback. An older API client can
ignore them, but its old startup schema-sync command might propose dropping
them. Start that older API directly without schema sync, or retain a compatible
schema file. Never accept data loss to make an older image start.
