# Databases, releases and persistent state

DevFlow hosts one HTTP app container per deployment. Generated images never
start a database server. Provision PostgreSQL/MySQL/MongoDB/Redis externally and
add the names the application expects (for example DATABASE_URL) through the
encrypted, write-only project environment API. Requirements scans code and
example files for names only; it does not import .env values, contact services,
test passwords or automatically translate database settings.

## Release and seed commands

Optional Project.releaseCommand and Project.seedCommand are validated at the
API and worker boundary: 1–1000 characters, no control characters or line
separators. After building and inspecting an image, the worker runs release,
then seed, each in a fresh foreground container using that same image, app
network, project env-file, user, CPU/RAM/pid/tmp/log limits and shared deployment
deadline. For example:

- `npx prisma migrate deploy`
- `python manage.py migrate --noinput`
- An application-specific, idempotent seed command

Docker arguments are arrays. The only allowed entrypoint override is /bin/sh;
the application command is one argument to `-ec` inside the isolated container,
never concatenated into a host shell command. The app-run allow-list remains
unchanged; a narrow release adapter validates its prefix using that validator.
There are no host paths, Docker sockets, privileged flags or published ports.

All one-off containers are removed on success, failure and timeout. Release or
seed failure prevents the new serving container/traffic switch. The previous
route stays current. Time spent building, releasing, seeding and health checking
shares the existing deployment budget; no quota or resource limit is increased.
Stored-image rollbacks skip release/seed commands and record that distinction.

Database side effects cannot be rolled back by Docker. Use expand/contract,
backward-compatible migrations while the old version serves traffic, keep
seeds idempotent and take database backups. A failed migration can have changed
an external database even though traffic remains on the old version.

## Stateless and external storage only

Persistent app volumes are intentionally not added. Host mounts would widen the
current security model, and per-container disk enforcement is not guaranteed on
every host. The existing image VOLUME policy and dockerSafety.ts are unchanged.

SQLite, local uploads and media files live in a container's writable layer.
They can survive a restart of that same container but are lost when it is
replaced. One-off release/seed containers do not share those local files with the
serving container. Preflight warns about local state and blocks release/seed
initialization of SQLite when no external database configuration is declared.
For a disposable demo only, an explicit startup command can initialize its own
SQLite file. For durable records or uploads use an external database or object
store; do not place real data on an assumed persistent app filesystem.
