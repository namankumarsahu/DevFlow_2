# Recipe regression workflow

When a real deployment fails, reduce it to a small committed reproducer under
backend/tests/fixtures/real. Remove node_modules, private data, credentials and
.env files. Preserve the relevant manifests, entry points and failure. Record
provenance honestly: these are reduced layouts, not full production copies.

Add expected.json with stack, support status, exact finding IDs, optional
settings/envNames and required Dockerfile substrings. First make the fixture
test fail, then fix detection/preflight/rendering, and keep the fixture. Pocket's
fixed-port/loopback reproducer must remain blocked; do not hide failures with
larger quotas, disabled TLS verification or relaxed Docker flags.

Run in backend:

```sh
npm test
npm run test:fixtures
npm run build
```

Then run the frontend build. Detection and preflight tests do not run app code
or access the network. The fixture runner stages copies in temporary folders,
so repeated runs never contaminate committed fixtures with .devflow files.

With Docker available, opt in to:

```sh
npm run test:docker-fixtures
```

The trusted host harness builds fixture images and starts app code only inside
Docker at 256 MB / 0.25 CPU, on runtime PORT=3587. It checks image user/size and
GET / = 200, then removes the containers and staged clones. Blocked fixtures are
reported as skips, not falsely reported as successful builds. Set
DEVFLOW_CA_BUNDLE to your public CA bundle on a TLS-inspected network. Optional
DEVFLOW_TEST_NETWORK makes the harness probe container DNS on an existing
network when the harness is already connected there. Otherwise it uses an
ephemeral loopback-only host port. No Docker socket is mounted into fixtures.

Every new strategy must implement the existing detect/render interface, join
the registry and official support matrix, and add fixtures covering requirements
and rendering. A future buildpack strategy must still execute its lifecycle
inside BuildKit. It must not execute repository code while detecting.

Deployment records persist stack, preflight result, status and failureClass
(clone/preflight/build/image-policy/release/health/routing/timeout/cancelled).
Authenticated admins can inspect GET /api/admin/build-reliability. It reports
first project attempts by stack; retries are not counted as new first successes.
Legacy uninspected rows do not enter the measured denominator, but prevent a
later retry from being mislabeled as a project's first attempt. Preflight blocks
are reported separately; this is HTTP deployment reliability, not proof of
business correctness or credential validity.
