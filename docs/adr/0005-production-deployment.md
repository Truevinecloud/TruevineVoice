# ADR 0005: CI-gated release directories and PM2 deployment

- **Status:** Accepted; supervised VPS adoption authorized on 2026-10-14
- **Date:** 2026-10-13

## Context

The old deployment workflow reset production Git state, installed without the
lockfile, deployed independently of CI, used an unpinned SSH action, and omitted
both Next.js apps. Production routing and current PM2 ownership are undocumented.
The schema has no models or migrations. Production `.env` and database data must
survive deployments unchanged.

## Decision

Use a `workflow_run` deployment restricted to successful push CI runs on this
repository's `main`, verifying all four CI jobs and checking the current main SHA.
Use native OpenSSH with a dedicated non-root account and independently verified
host keys. Keep GitHub checkout/setup actions pinned to full SHAs.

Transfer the tested SHA's source archive into an isolated incoming directory.
Build with the exact Node/npm pins, `npm ci`, Prisma generation/validation, and
the root build script on Ubuntu. Keep the original checkout and `.env` untouched;
link `.env` into completed releases. Use explicit PM2 entries for web, admin,
API and worker, binding HTTP services to loopback. Do not publish a new admin
route or alter Nginx/TLS without an existing-route audit.

The 2026-10-14 audit confirmed existing `/admin` and `/health` public routes.
Preserve the admin app's established `/admin` basePath. The legacy checkout's
local admin configuration and backup are retained for recovery; it is never a
release input, so dirty legacy Git state does not block an isolated source archive.
The owner authorized migration from root PM2 to a dedicated deployment account.
Restrict the existing environment file to root and the deployment group (640)
without changing its content. Keep the exact pinned runtime under
`/opt/truevine-runtime`, isolated from the legacy system Node installation.

Serialize deploys/rollbacks with GitHub concurrency and server-side flock.
Verify HTTP content, production SHA, dependencies and PM2 process stability.
Retain releases; save PM2 and switch `current` only on successful checks. Restore
and verify the previous release after activation failure, while keeping the job
failed. Existing PM2 processes require a supervised rollback baseline first.

Do not run migrations while the foundation schema is empty. Block deployment
when models or migration files appear until the SQL, backward compatibility,
and controlled execution plan are reviewed. Never run the development Compose
stack or destructive data commands in production.

## Consequences

Build failure does not interrupt production. Repeated source installs are
reproducible from the lockfile, but still depend on registry availability.
Each PM2 fork-mode reload can briefly interrupt that process; no zero-downtime
promise is made. Releases use disk until an audited retention procedure removes
them. A killed deployment process requires operator recovery from retained
releases. App versions report full commit SHAs. Future migrations must extend
this safety policy explicitly. Infrastructure provisioning and first PM2
ownership migration remain supervised operations, not CI side effects.
