# GitHub Actions workflows

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

The source archive is built on the VPS with `npm ci` and the repository scripts
in an isolated release directory. Explicit PM2 processes cover both Next.js
apps, API and worker. Activation verifies production SHA, dependencies, HTTP
content and stable PM2 processes. Failed activation restores the previous
release; the job stays failed. Builds do not modify the active release.

Complete the [production runbook](../../docs/runbooks/production-deployment.md)
before setting `DEPLOYMENT_READY=true`. Required secrets are `VPS_SSH_HOST`,
`VPS_SSH_USER`, `VPS_SSH_KEY`, and `VPS_SSH_KNOWN_HOSTS`; optional variable
`VPS_SSH_PORT` defaults to 22. Production configuration stays on the VPS.
No automatic Nginx changes, migrations, database resets or release pruning.
