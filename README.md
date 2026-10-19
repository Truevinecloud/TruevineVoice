# Truevine Voice

Multi-tenant automated customer engagement SaaS. The first channel is **outbound
Voice in Uganda**.

> **Status: engineering foundation.**
> This repository currently contains the build, test and infrastructure skeleton
> only. **No product functionality has been implemented.** There are no
> contacts, campaigns, audio, wallet, billing, voice, SMS, WhatsApp, RBAC,
> authentication or admin features yet. See
> [Deliberately deferred](#deliberately-deferred).

---

## Architecture

A **modular monolith** — one transactional boundary, deployable pieces, enforced
package boundaries.

| Layer         | Technology                                                    |
| ------------- | ------------------------------------------------------------- |
| `apps/web`    | Next.js 16 customer web application (App Router)              |
| `apps/api`    | NestJS 12 REST API                                            |
| `apps/worker` | NestJS 12 background worker (application context + BullMQ)    |
| `apps/admin`  | Next.js 16 platform-admin frontend (internal operators only)  |
| `packages/*`  | Framework-agnostic shared code                                |
| Data          | PostgreSQL (system of record) + Prisma 7                      |
| Async         | Redis + BullMQ                                                |
| Tooling       | TypeScript 6, ESLint 10, Prettier 3, Vitest 5, npm workspaces |

Every Node workspace is an **ES module**, because NestJS 12 is published
ESM-only. See [ADR 0002](./docs/adr/0002-runtime-and-toolchain-versions.md).

```
truevine-voice/
├── apps/
│   ├── admin/          Platform-admin frontend (placeholder only)
│   ├── api/            NestJS REST API  -> GET /health
│   ├── web/            Customer web application (public marketing homepage)
│   └── worker/         Background worker (no business queues yet)
├── packages/
│   ├── auth/           [reserved] authentication, RBAC
│   ├── database/       Prisma schema, client, health probe
│   ├── domain/         [reserved] pure business rules
│   ├── messaging/      [reserved] SMS / WhatsApp abstraction
│   ├── observability/  [reserved] logging, metrics, tracing
│   ├── payments/       [reserved] payments + immutable ledger
│   ├── pricing/        [reserved] plans, rating, price calculation
│   ├── queue/          Redis connection + BullMQ foundation
│   ├── shared/         env loading, health types, async helpers
│   ├── telephony/      [reserved] Voice abstraction (Africa's Talking later)
│   └── ui/             [reserved] shared UI primitives
├── infrastructure/     docker / environments / scripts
├── docs/               adr / api / runbooks
└── docker-compose.yml  local PostgreSQL + Redis
```

Packages marked `[reserved]` contain a `package.json` and a README explaining
their intended contents. They intentionally export nothing.

### Architectural rules

1. `apps` may depend on `packages`; `packages` **never** depend on `apps`.
2. `domain` and `pricing` **never** import provider SDKs.
3. Controllers never contain direct business database queries.
4. Provider integrations live behind interfaces and adapters.
5. PostgreSQL is the system of record. Redis/BullMQ carries asynchronous work
   only.
6. All tenant-owned data is organization-scoped.
7. Money is never a floating-point number.
8. Wallet accounting is an immutable, append-only ledger.
9. External paid operations require idempotency.
10. Secrets are never committed.

Full rules for coding agents live in [`AGENTS.md`](./AGENTS.md). Decisions and
their rationale live in [`docs/adr/`](./docs/adr/).

---

## Requirements

| Tool           | Version     | Notes                                                              |
| -------------- | ----------- | ------------------------------------------------------------------ |
| Node.js        | **24.19.0** | Pinned in `.nvmrc`; Active LTS. `.npmrc` sets `engine-strict=true` |
| npm            | **11.17.0** | Declared in `package.json` `engines`                               |
| Docker         | Any recent  | For local PostgreSQL and Redis only                                |
| Docker Compose | v2+         | `docker compose`, not `docker-compose`                             |

### Why Node 24?

Node 26 exists but is `Current`, not `LTS`. Every engine constraint in the
dependency graph (`@nestjs/schematics`, Prisma, ESLint, Next.js) accepts the Node
24 line, and LTS is the right choice for CI and production. Node 24.19.0 matches
what `@nestjs/schematics` requires at minimum (`^24.15.0`).

### Why TypeScript 6.0.3 and not the latest?

`typescript-eslint` requires `typescript >=4.8.4 <6.1.0`, while
`@nestjs/schematics` requires `typescript >=6.0.0`. **TypeScript 6.0.3 is the
only version satisfying both.** TypeScript 7 (the native-port major) is not yet
supported by the lint toolchain. See
[ADR 0002](./docs/adr/0002-runtime-and-toolchain-versions.md).

---

## Fresh-clone setup

These are the exact steps to get a clean checkout running locally. Follow them
in order; each step is verified by the next.

```bash
# 1. Use the pinned Node version
nvm use                       # reads .nvmrc -> 24.19.0

# 2. Install dependencies
npm install

# 3. Create your local environment file
cp .env.example .env          # Windows PowerShell: Copy-Item .env.example .env
```

`.env` ships working defaults: PostgreSQL on host port **55432** and Redis on
host port **56379**. These are deliberately _not_ the conventional 5432 / 6379,
because a developer machine often already runs another project's PostgreSQL or
Redis on those.

**If a host port is occupied**, edit `.env` and keep each pair consistent:

```dotenv
POSTGRES_PORT=<free port>
DATABASE_URL=postgresql://truevine:truevine@localhost:<same port>/truevine_voice?schema=public

REDIS_PORT=<free port>
REDIS_URL=redis://localhost:<same port>
```

Then restart the containers so they pick up the new mapping:

```bash
npm run infra:down
npm run infra:up
```

`docker-compose.yml` reads `POSTGRES_PORT` / `REDIS_PORT` from `.env`. The
container ports stay fixed at 5432 and 6379; only the published host ports
change. Both services publish on `127.0.0.1` only, so local infrastructure is
not reachable from the local network.

```bash
# 4. Start PostgreSQL and Redis and wait until both report healthy
npm run infra:up

# 5. Confirm both services are up
docker compose ps
```

Expected — both `healthy`, on the ports from your `.env`:

```
NAME                IMAGE                STATUS         PORTS
truevine-postgres   postgres:18-alpine   Up (healthy)   127.0.0.1:55432->5432/tcp
truevine-redis      redis:8-alpine       Up (healthy)   127.0.0.1:56379->6379/tcp
```

```bash
# 6. Validate the schema and generate the Prisma client
npm run prisma:validate
npm run prisma:generate

# 7. Quality gates
npm run lint
npm run typecheck
npm test            # unit tests, no infrastructure needed

# 8. End-to-end tests (needs the containers from step 4)
npm run test:e2e

# 9. Production build
npm run build

# 10. Run the applications
npm run dev
```

Then confirm the API:

```bash
curl http://localhost:3001/health
```

> **Never point the application at infrastructure you did not start.**
> If `npm run infra:up` fails, fix the port mapping before continuing. The
> infrastructure E2E tests assert that PostgreSQL really is the `truevine_voice`
> database and that Redis really is answering on the port from `REDIS_URL`, so a
> wrong target fails loudly instead of passing by accident.

On Windows without `nvm`, install Node 24.19.0 directly. `npm install` fails
fast with a clear message if the runtime does not match `engines`.

### Ports

| Service    | Host port | Container port | How to change it                                  |
| ---------- | --------- | -------------- | ------------------------------------------------- |
| Web        | 3000      | —              | `apps/web/package.json` → `dev`/`start` scripts   |
| API        | 3001      | —              | `API_HOST` / `API_PORT` in `.env`                 |
| Admin      | 3002      | —              | `apps/admin/package.json` → `dev`/`start` scripts |
| PostgreSQL | 55432     | 5432           | `POSTGRES_PORT` in `.env` + `DATABASE_URL`        |
| Redis      | 56379     | 6379           | `REDIS_PORT` in `.env` + `REDIS_URL`              |

The Next.js ports are hardcoded in each app's npm scripts rather than read from
the environment, because `${VAR:-default}` shell syntax does not work under
`cmd.exe` and would make the scripts Windows-only.

`npm run dev` runs the API, worker, web and admin dev servers together.

---

## Health endpoint

```bash
curl http://localhost:3001/health
```

```json
{
  "status": "ok",
  "service": "truevine-voice-api",
  "version": "0.1.0",
  "environment": "development",
  "uptimeSeconds": 42,
  "timestamp": "2026-10-07T12:00:00.000Z",
  "dependencies": {
    "postgres": { "status": "up", "latencyMs": 3 },
    "redis": { "status": "up", "latencyMs": 1 }
  }
}
```

- `200` when every dependency is reachable.
- `503` with the same body shape when any dependency is down, so orchestrators
  and humans read an identical payload.

This is **infrastructure** health, not business health. It probes PostgreSQL
with `SELECT 1` and Redis with `PING`.

---

## Commands

### Development

| Command              | Description                             |
| -------------------- | --------------------------------------- |
| `npm run dev`        | API + worker + web + admin concurrently |
| `npm run dev:api`    | API only                                |
| `npm run dev:worker` | Worker only                             |
| `npm run dev:web`    | Web only                                |
| `npm run dev:admin`  | Admin only                              |

### Quality gates

| Command             | Description                                         |
| ------------------- | --------------------------------------------------- |
| `npm run lint`      | ESLint across every workspace                       |
| `npm run lint:fix`  | ESLint with autofix                                 |
| `npm run typecheck` | Builds packages, then `tsc --noEmit` everywhere     |
| `npm run test`      | Unit tests. **No infrastructure required**          |
| `npm run test:e2e`  | End-to-end tests. **Requires PostgreSQL and Redis** |
| `npm run build`     | Builds packages, then all apps                      |

### RBAC-001 security remediation

The [remediation report](docs/rbac-001-security-remediation.md) supersedes the
earlier merge review. [ADR 0010](docs/adr/0010-rbac-001-security-transactions.md)
records transaction boundaries, exactly-one-Owner constraints and terms exceptions.

- `npm run test:security`: requires the local Compose PostgreSQL/Redis stack.
  Creates disposable databases, applies migrations through Prisma on the empty
  one, rehearses representative/inconsistent data, runs all integration tests,
  and drops only those databases. It never migrates the existing development DB.
- `npm run test:security:baseline`: runs the same two race-contract tests against
  the frozen pre-fix store in a disposable schema. **Expected exit: nonzero**;
  this is explicit before-fix reproduction, not a passing verification gate.

Organizations and their first Owner must commit together. New inconsistent
constraints fail with an actionable diagnostic and never repair customer data.
Run these commands through npm so their subprocesses use the pinned runtime.
Production approval, legal terms, email delivery, operator recovery and audit
policy remain separate prerequisites. `DEPLOYMENT_READY=false`.

### RBAC-001 merge review

The historical [security and merge-readiness review](docs/rbac-001-merge-readiness-review.md)
recommends **NOT MERGE READY** despite passing ordinary test suites. Local review
fixes use matching Prisma CLI/client/adapter 7.10.1 pins; the full audit has five
remaining high development-tool findings, and production-only audit has zero.
The older audit discussion below is historical; the review records current
advisory paths, exposure and why an ESLint downgrade was not considered safe.
No migrations were changed or approved. `DEPLOYMENT_READY=false`.

### RBAC-001 development verification

RBAC-001 is implemented on this feature branch. Foundation descriptions above
are historical; see [final verification](docs/rbac-001-final-verification.md).

With the isolated local API/web servers running, development email capture
enabled, and the development schema already prepared:

- `npm run verify:journey`: disposable accounts, activation, test terms, dashboard,
  settings, team/invitations, ownership transfer, token reuse, session revocation
  and action-specific audit records through the real frontend proxy.
- `npm run verify:boundaries`: two independent tenants, forged IDs, CSRF,
  delegation and audit immutability against local API/Docker infrastructure.
- `npm run verify:frontend`: rendered HTML and HTTP checks. Requires
  `OWNER_EMAIL` and `OWNER_PASSWORD` for a disposable development Owner; missing
  credentials fail rather than silently skipping authenticated verification.

These commands do not automate a browser. They retain the real rate limiter;
HTTP 429 requires waiting for its window. Test rows with immutable audit
references remain in development. No command applies migrations.
`DEPLOYMENT_READY=false`; see [release blockers](docs/release-blockers.md).

### Continuous integration

GitHub Actions runs these gates on every pull request targeting `main` and on
every push to `main`, as four parallel jobs:

| Job          | Gate                                                      | Needs PostgreSQL / Redis |
| ------------ | --------------------------------------------------------- | ------------------------ |
| `quality`    | `prisma:generate`, `prisma:validate`, `lint`, `typecheck` | no                       |
| `unit-tests` | `npm test`                                                | no                       |
| `e2e-tests`  | `npm run test:e2e` against a real Compose stack           | yes                      |
| `build`      | `npm run build`                                           | no                       |

CI uses no repository or organisation secrets: the only credentials are the
disposable local-development values already in `docker-compose.yml`. Node comes
from `.nvmrc` and npm from `package.json#packageManager`. The pipeline never
runs `prisma migrate deploy`, and the CI workflow itself does not deploy. A separate deployment workflow
follows successful main-push CI after production prerequisites are configured.

See [`.github/workflows/README.md`](./.github/workflows/README.md) for the design
notes and [ADR 0004](./docs/adr/0004-github-actions-ci.md) for why the E2E job
starts the repository's own Compose stack rather than a `services:` container.

The separate `PostgreSQL restore integration` workflow tests real backup/restore
and failure cleanup on a fresh GitHub-hosted Ubuntu runner. It uses no secrets,
deployment jobs or migrations. `npm run test:restore-integration:checks` runs its
Docker-free safety tests locally; `npm run test:restore-integration` requires that
hosted runner and an empty local Docker daemon, and fails elsewhere. See the
[workflow notes](.github/workflows/README.md#restore-integrationyml).

### Formatting

| Command                | Description                            |
| ---------------------- | -------------------------------------- |
| `npm run format`       | Prettier write                         |
| `npm run format:check` | Prettier check (**not yet** a CI gate) |

### Infrastructure

| Command               | Description                               |
| --------------------- | ----------------------------------------- |
| `npm run infra:up`    | Start PostgreSQL + Redis, wait for health |
| `npm run infra:ps`    | Service status                            |
| `npm run infra:logs`  | Tail logs                                 |
| `npm run infra:down`  | Stop, keep data                           |
| `npm run infra:reset` | Stop and **delete all local data**        |
| `npm run db:reset`    | `infra:reset` then `infra:up`             |

### Database

| Command                         | Description                                             |
| ------------------------------- | ------------------------------------------------------- |
| `npm run prisma:validate`       | Validate `schema.prisma` (no database needed)           |
| `npm run prisma:generate`       | Generate the typed Prisma client                        |
| `npm run prisma:migrate:dev`    | Create and apply a development migration                |
| `npm run prisma:migrate:deploy` | Apply pending migrations (controlled environments only) |
| `npm run prisma:studio`         | Prisma Studio                                           |

> `npm run typecheck` and `npm run test` build `packages/*` first, because apps
> resolve `@truevine/*` through their built `dist` output.
>
> `npm run prisma:migrate:deploy` is a supervised operator action. It is not run
> by CI, and it is never the right command against a database you did not create.

---

## Database

The Prisma schema holds the **tenancy core only**.

```prisma
model Organization { ... }   // unit of tenancy, unique immutable slug
model Membership   { ... }   // principal <-> organization, coarse role
enum MembershipRole { OWNER, ADMIN, OPERATOR, VIEWER }
```

`Contact`, `Campaign`, `Call`, `Audio`, `Wallet`, `LedgerEntry` and `Billing` do
**not** exist yet. Money handling (AGENTS.md 6-7) and idempotency (AGENTS.md 9)
are not expressed anywhere in the schema, so no financial table is introduced
before those rules are agreed.

### Tenant isolation lives in the schema

`memberships` has **no `id`**. Its primary key is `(organization_id, user_id)`,
so tenant scope is part of row identity rather than a column a query might forget
to filter on. Three consequences:

- A membership cannot exist without an organization.
- A user holds at most one role per organization, so "which role applies" is never
  ambiguous.
- Authorization is per tenant: one person in two organizations is two
  memberships with independent roles.

Every future tenant-owned table must follow the same rule: a primary key or
unique index that **leads with** `organization_id`, and a foreign key that
**carries** `organization_id` alongside the parent id. A bare foreign key to a
parent row's id is a cross-tenant write waiting to happen. See
[ADR 0006](./docs/adr/0006-tenancy-core-schema.md).

> **The first migration is unreviewed and blocks production deployment.**
> `assertNoMigrations` refuses to deploy a tree containing any model or
> migration. That is intentional. The reviewed SQL, backward-compatibility
> argument, rollback and supervised execution plan are in ADR 0006. Read it
> before changing the interlock.

The generator uses the Prisma 7 `prisma-client` generator (`prisma-client-js` is
deprecated) with `moduleFormat = "esm"` to match the repository's ESM-only Node
workspaces. Health probing uses `SELECT 1`, which works with or without tables.

The generated client (`packages/database/src/generated/`) is gitignored, so
`npm ci` does not produce it. Run `npm run prisma:generate` after a fresh clone
and before `npm run typecheck`, `npm test` or `npm run build` — which is why
every CI job that compiles or runs code does the same.

---

## Testing

```bash
npm run test       # unit tests, no Docker needed
npm run infra:up   # for e2e
npm run test:e2e   # end-to-end, needs PostgreSQL + Redis
```

Unit tests never touch PostgreSQL or Redis: infrastructure is injected through
the same NestJS injection tokens production uses, with fakes substituted. There
are no silent skips — an end-to-end test that needs a dependency and cannot
reach it fails loudly, which is intentional.

`packages/database/test/tenancy.e2e-spec.ts` asserts the tenancy rules against
live PostgreSQL: the database rejects an orphan membership, a duplicate
organization slug and a duplicate membership, and cascade delete removes an
organization's memberships. That is the point of putting tenant scope in the
schema — a missing `where` clause becomes a test failure rather than a breach.
Every test runs inside a transaction that is rolled back, so the suite leaves no
rows behind and can be run repeatedly.

---

## Configuration

`.env` lives at the repository root and is gitignored. `.env.example` contains
safe placeholders only.

| Variable                  | Required | Default       | Purpose                                     |
| ------------------------- | -------- | ------------- | ------------------------------------------- |
| `DATABASE_URL`            | yes      | —             | PostgreSQL connection string                |
| `REDIS_URL`               | yes      | —             | Redis connection string                     |
| `NODE_ENV`                | no       | `development` | Environment name                            |
| `APP_VERSION`             | no       | `0.1.0`       | Reported by `/health`                       |
| `API_HOST`                | no       | `0.0.0.0`     | API bind address                            |
| `API_PORT`                | no       | `3001`        | API port                                    |
| `HEALTH_CHECK_TIMEOUT_MS` | no       | `2000`        | Per-dependency health timeout               |
| `POSTGRES_PORT`           | no       | `5432`        | Host port Compose publishes PostgreSQL on   |
| `REDIS_PORT`              | no       | `6379`        | Host port Compose publishes Redis on        |
| `LOG_LEVEL`               | no       | —             | `debug` enables extra Prisma client logging |

Configuration is validated at start-up. A missing required variable or a
malformed value **fails the boot** with an actionable message rather than
degrading silently at runtime. `.env` lives at the repository root and is
gitignored; `packages/*` and `apps/*` find it by walking up from the current
working directory.

Authentication secrets, Africa's Talking credentials, payment credentials and
object storage credentials are **not** defined yet. They are added when the
corresponding behaviour is implemented.

---

## Known dependency advisories

`npm audit` reports **9 high-severity** advisories and **no criticals**. All
nine come from dev-only tooling and none are reachable from application code:

| Advisory       | Via                  | Assessment                                                                |
| -------------- | -------------------- | ------------------------------------------------------------------------- |
| `braces`       | `eslint-config-next` | No fixed version exists upstream (`3.0.3` is latest and affected).        |
| `deepmerge-ts` | `prisma` (CLI)       | Fixed only in `8.x`; `@prisma/config` requires `<8.0.0`.                  |
| `mysql2`       | `prisma` (CLI)       | Unused: Prisma is configured for PostgreSQL only. Fixed only in `3.24.x`. |

`npm audit fix --force` would resolve them only by downgrading
`eslint-config-next` to 14.x or `prisma` to 6.x — both major downgrades that
would break the build. They are deliberately **not** applied. Revisit when
upstream ships fixes.

One critical advisory (`shell-quote` via `concurrently`) was resolved by an npm
`overrides` entry pinning `shell-quote` to `1.12.0`; `concurrently@10.0.5`
hard-pins the vulnerable `1.9.0`.

---

## Deliberately deferred

Not implemented in this step, by design:

- **Product functionality:** Contacts, Campaigns, Audio, Wallet, Billing, Voice,
  SMS, WhatsApp, RBAC, authentication, admin functionality.
- **Africa's Talking adapter:** will be the first Voice provider, behind the
  `@truevine/telephony` interface. Not started.
- **Database models beyond tenancy:** Contact, Campaign, Call, Audio, Wallet,
  LedgerEntry, Billing. Only Organization and Membership exist. See
  [Database](#database).
- **Production migration execution:** the tenancy migration is authored and
  reviewed on paper but has **not** been applied to production. See
  [ADR 0006](./docs/adr/0006-tenancy-core-schema.md).
- **Business queues:** none. The worker establishes Redis/BullMQ connections and
  readiness only.
- **OpenAPI:** deferred until the first product endpoints exist.
- **Prettier as a CI gate:** `npm run format:check` is not yet a required check.
  Three files are unformatted; see
  [`.github/workflows/README.md`](./.github/workflows/README.md).
- **Infrastructure provisioning:** production database provisioning, container
  images and infrastructure-as-code remain deferred. CI-gated PM2 deployment
  targets the existing Ubuntu VPS; see the production runbook.
- **Observability vendor:** no logging/metrics SDK selected. Nest's built-in
  `Logger` is used.

---

## Troubleshooting

**`npm install` fails with an engine error**
Your Node version does not match `engines`. Run `nvm use`, or install Node
24.19.0. `.npmrc` sets `engine-strict=true` deliberately.

**`GET /health` returns 503**
Start infrastructure with `npm run infra:up`, or inspect
`npm run infra:ps`. The response body names the failing dependency and its error.

**`Missing required environment variable "DATABASE_URL"`**
`.env` does not exist at the repository root. Run
`cp .env.example .env`.

**`npm install` warns about `allowScripts`**
npm blocks dependency install scripts by default. `prisma`, `@prisma/engines`,
`unrs-resolver` and `msgpackr-extract` need theirs to download engines and
native helpers. They are approved explicitly in the root `package.json`
`allowScripts` block; that block is committed so every developer and CI gets the
same behaviour.

**`docker compose up` fails with "port is already allocated"**
Something else on the machine already holds 5432 or 6379. Set `POSTGRES_PORT`
and `REDIS_PORT` in `.env` to free ports, and update `DATABASE_URL` /
`REDIS_URL` to match. Nothing else needs to change.

**A package cannot be resolved after editing `packages/*`**
`packages/*` are consumed through their built `dist` output. Run
`npm run build:packages`.

**API port already in use**
Override it with `API_PORT` in `.env`. For the Next.js apps, edit the port in
`apps/web/package.json` or `apps/admin/package.json`.

**`Cannot find module '@swc/core'`**
Not a supported setup: the toolchain deliberately uses no native transformer.
If you see this, something reintroduced `@swc/core`; see
[ADR 0002](./docs/adr/0002-runtime-and-toolchain-versions.md).

**Next.js rewrote `apps/*/tsconfig.json`**
Expected on the first `next build`: Next sets `jsx: react-jsx` and adds
`.next/dev/types` to `include`. Commit the result rather than reverting it.

## Production deployment

The existing Ubuntu VPS is deployed through a successful main-push CI run.
The pipeline builds all four real applications in separate release directories,
uses a dedicated non-root SSH account with pinned host keys, preserves the
production `.env` and databases, and verifies PM2 and local/public HTTP health.
The 2026-10-14 audit confirmed the existing `/admin` and `/health` routes.
The deployment uses an isolated pinned runtime under `/opt/truevine-runtime`
and preserves the legacy checkout for recovery. See the runbook for first cutover.

See [production setup, secrets, routing and rollback](./docs/runbooks/production-deployment.md),
[deployment audit and verification](./docs/runbooks/deployment-audit.md), and
[ADR 0005](./docs/adr/0005-production-deployment.md).

| Command                                        | Purpose                                                                       |
| ---------------------------------------------- | ----------------------------------------------------------------------------- |
| `npm run ci:setup-npm`                         | Verify exact Node pin; install/verify the pinned npm if necessary             |
| `npm run test:deployment`                      | Deployment safety and rollback tests without infrastructure                   |
| `npm run deploy:release -- <SHA>`              | Linux VPS only: build/activate the uploaded release under the deployment lock |
| `npm run deploy:rollback -- <SHA>`             | Linux VPS only: reactivate a retained verified release                        |
| `npm run deploy:verify -- <config-path> <SHA>` | Verify local and confirmed public foundation pages/API                        |

`npm test` also runs deployment safety tests. Deploy commands require the
server-local `deployment.json`, existing readable `.env`, matching Node/npm,
and PM2. They never reset Git, run development Compose, or apply migrations.
