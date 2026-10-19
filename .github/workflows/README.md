# GitHub Actions workflows

## `restore-integration.yml`

Independent, optional integration verification on GitHub-hosted `ubuntu-24.04`.
Triggers on relevant feature-branch pushes, pull requests, or manual dispatch;
it does not trigger the production deployment workflow or alter existing gates.
It reads no secrets, references no environment, and grants only `contents: read`.

`npm run test:restore-integration` requires a hosted Linux runner and forces the
local Unix Docker socket, ignoring inherited remote contexts and TLS settings.
It refuses a daemon containing any containers or volumes. It creates a labeled
PostgreSQL 18 fixture named `truevine-postgres` solely to satisfy the unchanged
recovery CLI's fixed source identity; this is a disposable database created by
the harness, never an existing production resource. No ports are published and
all PostgreSQL containers run with `--network none`. No migrations are applied.

The fixture contains 11 public tables with rows, a private table, a public view,
an enum, an index and constraints. Real `pg_dump` archives contain both TABLE
and TABLE DATA entries. Both `verify-restore` and `verify-volume` must pass with
11 public tables. A second readable archive intentionally excludes a schema
needed by a column default; both commands must fail during real `pg_restore`.
Each case asserts that rehearsal containers/volumes are gone **before** fallback
cleanup. The source fixture must survive each case; final cleanup removes it
and asserts an empty daemon. The EXIT trap and an `always()` step provide
label-checked emergency cleanup; runner disposal also bounds cancellation.

`npm run test:restore-integration:checks` validates workflow syntax and safety
contracts without Docker; `npm run test:db-verify` runs the existing Linux stub
regressions. Missing Docker fails the hosted integration job, rather than
silently skipping it. Logs contain the archive-count assertions, restoration
fingerprints, real PostgreSQL errors and per-case cleanup results. A prepared
workflow is not evidence of a successful integration run: the hosted result
must pass before authorizing the PR. Nothing is published or dispatched by
preparing these files.

## `ci.yml`

Continuous integration. Triggered by pull requests targeting `main` and by
pushes to `main`.

| Job          | Gate                                                      | Needs PostgreSQL / Redis |
| ------------ | --------------------------------------------------------- | ------------------------ |
| `quality`    | `prisma:generate`, `prisma:validate`, `lint`, `typecheck` | no                       |
| `unit-tests` | `npm test`                                                | no                       |
| `e2e-tests`  | `npm run test:e2e` against a real Compose stack           | yes                      |
| `build`      | `npm run build`                                           | no                       |

Each job runs `npm ci` independently and in parallel.

### Design notes

- **Least privilege.** `permissions: contents: read` is the only token scope.
  No job writes to the repository, creates releases, or references an
  environment. Checkout uses `persist-credentials: false`, so a compromised test
  step cannot push.
- **Actions pinned to commit SHAs.** `actions/checkout` and `actions/setup-node`
  are referenced by full commit SHA with the release tag in a trailing comment,
  so a moved tag cannot change what executes. Bump them deliberately.
- **No secrets.** The workflow references no repository or organisation secret.
  The only credentials are the disposable `truevine` / `truevine` values already
  committed in `docker-compose.yml` for local development. A guard step asserts
  that `.env` is not tracked by git.
- **Concurrency.** One run per ref. Superseded pull-request runs are cancelled;
  runs on `main` always finish so a pushed commit is fully verified.
- **Runtime pinned from source.** Node from `.nvmrc`, npm installed/checked against
  `package.json#packageManager`. `.npmrc` sets `engine-strict=true`.
- **`prisma:generate` runs in every job that compiles or executes code.**
  `packages/database/src/generated/` is gitignored, so `npm ci` does not produce
  it and `build:packages` fails without it.
- **`prisma migrate deploy` is never run here.** It is a controlled-environment
  command and must not execute on a pull request.
- **E2E uses `docker compose`, not `services:`.** The infrastructure E2E tests
  assert that _this project's_ Compose stack owns the configured host ports, via
  `docker compose port`. A `services:` container has no Compose project and would
  fail those assertions. Teardown is `docker compose down --volumes` against the
  ephemeral runner only. See [ADR 0004](../../docs/adr/0004-github-actions-ci.md).

### Scripts the pipeline relies on

All of these already existed; adding the workflow required no application
changes.

| Script                    | Purpose                                          |
| ------------------------- | ------------------------------------------------ |
| `npm ci`                  | Reproducible install from the lockfile           |
| `npm run prisma:generate` | Generates the typed Prisma client                |
| `npm run prisma:validate` | Validates `schema.prisma` without a database     |
| `npm run lint`            | ESLint across the whole monorepo                 |
| `npm run typecheck`       | `tsc --noEmit` in every workspace                |
| `npm test`                | Unit tests, no infrastructure required           |
| `npm run test:e2e`        | End-to-end tests, requires PostgreSQL and Redis  |
| `npm run build:packages`  | Builds `packages/*` (required before `test:e2e`) |
| `npm run build`           | Builds packages, then apps                       |

`npm run typecheck` and `npm test` have their own `build:packages` hooks.
`npm run test:e2e` does not, which is why the E2E job builds packages
explicitly.

## Not configured here

`npm run format:check` is **not** a CI gate yet. It currently reports three
files that need `npm run format`: `apps/api/test/health.infrastructure.e2e-spec.ts`,
`apps/worker/test/worker.e2e-spec.ts` and `README.md`. Those files are
pre-existing and unrelated to this workflow, so they were left alone rather than
silently reformatted as part of a CI change. Run `npm run format` and open that
as its own change before adding the gate.

## `deploy.yml`

Triggered by completion of CI, restricted to successful push runs on main from
this repository. Verifies all four CI jobs, checks the exact main SHA, and uses
a protected production environment. Deployment uses OpenSSH, a non-root SSH
account and independently verified known_hosts; no third-party SSH action.

It can also be run manually from the Actions tab (`workflow_dispatch`) to
redeploy the current main commit. A manual run has no `workflow_run` payload, so
it resolves the CI run for the selected commit and accepts only a completed,
successful `push` run from this repository before verifying the same four gates.
A manual run still refuses a commit that is not the tip of main, so it cannot
publish an unreviewed or superseded commit.

The source archive is built on the VPS with `npm ci` and the repository scripts
in an isolated release directory. Explicit PM2 processes cover both Next.js
apps, API and worker. Activation verifies production SHA, dependencies, HTTP
content and stable PM2 processes. Failed activation restores the previous
release; the job stays failed. Builds do not modify the active release.

Complete the [production runbook](../../docs/runbooks/production-deployment.md)
before setting `DEPLOYMENT_READY=true`. Required secrets are `VPS_SSH_HOST`,
`VPS_SSH_USER`, `VPS_SSH_KEY`, and `VPS_SSH_KNOWN_HOSTS`; optional variable
`VPS_SSH_PORT` defaults to 22. Production configuration stays on the VPS.
Reviewed migrations run through `prisma migrate deploy` after the build and before PM2 activation. Migration failure leaves the active release untouched. No automatic Nginx changes, database resets or release pruning.
