# Create a project

Paste a GitHub repository URL and choose **Analyze**. DevFlow derives the project
name and reads the default branch from GitHub, then shows the existing deployment
plan, detected folders, build/start commands, configuration requirements and
warnings. Analysis does not start a deployment. **Deploy** requires a current
reviewed plan without blockers, even for administrators in this create flow.

The unchanged preflight API requires a saved project. Analyze therefore saves
an undeployed project, which uses a project quota slot but no deployment attempt.
Repeated analysis in the same flow reuses that project. If you leave or reload,
it remains in the project list and can be continued in project settings.

## Choosing an application

A detected frontend/backend pair offers Both, Frontend only and Backend only.
Both means the existing supported single-container recipe; this is not general
multi-service hosting. Ambiguous folders and Python module:application targets
offer detected dropdown choices. A single unambiguous suggestion is selected
automatically, with one bounded recheck. Selecting an app disables repository
defaults just as the existing Requirements selection does. Review its new plan.

Manual folder and Python entry-point inputs appear in Advanced only when the
detector has no candidates for that field. The backend still validates every
selection, root, command, port and resource request. Unsupported layouts remain
blocked; the UI does not invent entry points or migration commands.

## Variables and migrations

Required/missing variable names have password-style inputs. Save variables and
analyze again before deploying; entered unsaved values disable Deploy. Values
use the existing encrypted environment endpoint and are cleared after saving.
Optional/defaulted inputs can remain empty. Browser build-time variables still
require separate public build configuration, as reported by preflight.

Run database migrations on deploy uses the reported release command. The checkbox
is checked when one exists, and disabled if no command was detected/configured.
Add a release command in Advanced if necessary. Clearing an inherited command
with null would re-enable devflow.json inheritance, so unchecking writes an
explicit POSIX no-op (`true # DevFlow: skip migrations`). The existing release
container may still run this no-op; no migration runs, and other repository
defaults remain intact. Rechecking restores the reviewed command. No command is
guessed from a framework name. Seed commands are exposed only in Advanced.

## Advanced settings

Name, branch, environment, port, build type, root, entry point, readiness path,
build/start/release/seed overrides and the devflow.json toggle remain available.
The default environment is PRODUCTION and port is 3000. The platform supplies
PORT; apps must bind to 0.0.0.0 and that port. Tooltips link here and to
[repository configuration](REPOSITORY-CONFIGURATION.md).

GitHub metadata is fetched without a DevFlow token or browser credentials. A
private repository, rate limit or network failure may prevent branch discovery;
the UI asks you to retry or enter the branch in Advanced, and never guesses main.
Private repository credentials still use the existing project-settings workflow.

Settings changes, entered unsaved values, expired reviews and rejected stale
plans disable Deploy until reviewed again. A changed plan is never automatically
deployed after a rejection. The backend remains responsible for final quotas,
permissions, freshness, validation and sandbox policy.

## Frontend checks

From frontend, run `npm ci`, `npm test` and `npm run build`. Tests type-check the
UI and test files, then use Vitest, React Testing Library and jsdom for the
Analyze/review/Deploy flow and existing API/advanced-field contracts. GitHub and
DevFlow responses are mocked; these checks do not build or deploy real user apps.
