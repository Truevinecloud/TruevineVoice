# ADR 0004: Continuous integration runs the real Compose stack for E2E tests

- **Status:** Accepted
- **Date:** 2026-10-08

## Context

CI has to run the end-to-end tests, which boot the real NestJS API and worker
against live PostgreSQL and Redis. GitHub Actions offers two ways to provide
those dependencies:

1. `services:` containers declared on the job.
2. The repository's own `docker-compose.yml`, started inside the job.

The existing E2E tests deliberately reject option 1. Both
`apps/api/test/health.infrastructure.e2e-spec.ts` and
`apps/worker/test/worker.e2e-spec.ts` shell out to
`docker compose port postgres 5432` (and `redis 6379`) and assert that the
port the application is configured with matches the port _this project's
Compose stack_ publishes. The API test additionally asserts
`current_database() = 'truevine_voice'` and `current_user = 'truevine'`.

That is a deliberate design decision, not incidental strictness: it turns
"attached to somebody else's database on port 5432" into a loud failure instead
of an accidental pass. A `services:` container has no Compose project, so
`docker compose port` fails and the test suite fails with it.

Weakening those assertions to accommodate `services:` would be a regression in
safety and would require editing application tests to make a pipeline pass.

## Decision

**The E2E CI job starts the repository's own Compose stack.**

- `docker compose up -d --wait`, then `npm run test:e2e`, then
  `docker compose down --volumes` with `if: always()`.
- The stack is created on an ephemeral GitHub-hosted runner, is bound to
  loopback only, and uses the disposable credentials already committed in
  `docker-compose.yml` (`truevine` / `truevine`). They are local development
  placeholders, not secrets.
- No repository or organisation secrets are referenced anywhere in the
  workflow. The only token scope is `contents: read`, and checkout does not
  persist credentials.
- `prisma migrate deploy` is never run in CI. It stays a
  controlled-environment command (AGENTS.md section 12).

### Host is `localhost`, not `127.0.0.1`

The E2E job sets `REDIS_URL=redis://localhost:<port>` and a matching
`DATABASE_URL`, matching `.env.example`. The worker's infrastructure E2E test
asserts `redis.stream.remotePort`, and that socket property is only reliably
populated for a hostname on the platforms this repository is developed on. An
IP literal leaves `remotePort` undefined and the test fails for a reason that has
nothing to do with the code under test.

### Pinning the runtime

- Node comes from `.nvmrc` (`24.19.0`) via `node-version-file`, so the CI
  runtime cannot drift from ADR 0002.
- npm is verified against `package.json#packageManager` before install.
  `.npmrc` sets `engine-strict=true`, so a mismatch would fail `npm ci` anyway;
  the explicit check produces a clearer message and identifies npm specifically.
- `npm run prisma:generate` runs in every job that compiles or executes code,
  because `packages/database/src/generated/` is gitignored and `npm ci` does not
  produce it. Verified locally: after a clean `npm ci` the generated client is
  absent and `build:packages` fails on the missing module.

## Consequences

- The lint, typecheck, unit-test and build jobs need no database at all, and are
  structured so that only the E2E job touches infrastructure.
- CI cost is four `npm ci` runs. The npm cache from `actions/setup-node` keeps
  this acceptable, and the jobs run in parallel.
- If the Compose stack is replaced later (a different provisioner, or a decision
  to relax the identity assertions), this ADR must be revisited. Relaxing the
  assertions is the change that would need the strongest justification, because
  it removes a guard against silently testing against the wrong database.
