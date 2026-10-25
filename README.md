# Truevine Voice

## W3-03 Campaign Builder

`/app/campaigns` provides a minimal draft builder for campaign name, an existing
organization audio asset, existing contact groups, future schedule and bounded
retry settings. Draft edits are organization-scoped and preflight estimates
currently consented, unsuppressed contacts without creating recipient snapshots
or starting execution. Campaign schedules are saved preparation data only; no
outbound calls or provider services are activated. Preflight requires an audio
asset, at least one eligible audience contact and a schedule 5 minutes to 365
days ahead. Retry attempts are 1–5 including the initial attempt; delay is 5–1440
minutes. See [ADR 0023](docs/adr/0023-campaign-draft-preparation.md).

## W2-02 Increment 2 — Contact groups

`/app/contact-groups?organization=<membership-organization-id>` supports group
creation, viewing, renaming, deletion and adding/removing existing contacts.
Group names are trimmed, whitespace-normalized, limited to 120 characters and
unique ignoring case within an organization. A contact can belong to multiple
groups. Member lists are paginated; the contact picker searches existing contacts.

Existing `contact:read`, `contact:create` and `contact:update` permissions apply
(Owner, Admin and Campaign Manager). Viewer/Billing gain no group access.
Group writes recheck current permissions in the database transaction and audit
the committed change. Membership retries are idempotent and do not duplicate
links/audits. Deleting a group removes its links while preserving contacts,
consent/suppression and campaign/call history. Membership grants no consent.

The existing schema's composite tenant keys/foreign keys and normalized-name
uniqueness are reused; no migration or dependency is required. CSV import,
consent/suppression management and full UI redesign remain out of scope.
See [W2-02 acceptance tracking](docs/w2-02-acceptance.md), including the pending
Increment 1 deletion, Viewer/Billing and cross-tenant live checks.

## W2-02 phone corrections

Users with `contact:update` (Owner, Admin and Campaign Manager) can correct a
contact's phone in Contacts. The API uses the same E.164 normalization as creation,
rejects invalid input and organization-level duplicates (including legacy
destinations), and updates both contact destination fields atomically.

A different number is refused with `contact_phone_change_restricted` (HTTP 409)
when any consent evidence, suppression data or campaign recipient reference
exists, including draft campaigns. Keep the restricted record and create a
separate contact; consent must be recorded independently for that number.
Name/email edits and submitting the same normalized phone remain supported.
Known consent/suppression disables the phone input; campaign-history restrictions
are checked on save and shown in the form. The API rechecks restrictions under a
database row lock and writes a transactional `contact.updated` audit containing
changed field names, without copying phone numbers into the audit.
No recipient snapshots, call history, consent policies or execution are changed.

Production test-account executor (disabled by default):
[executable commands, private inputs and approvals](docs/runbooks/production-test-account-execution.md).
`npm run rollout:test-accounts -- inventory` and `-- template` print only public
inventory/invalid blank input shapes. Actions `bootstrap`, `initialize`,
`provision`, `verify`, `http` and `disable` require private approval/credential
files; production additionally requires explicit confirmation and a matching
active READY release and an action-bound Ed25519 owner signature. The owner signs
each short-lived approval with `npm run rollout:test-accounts:sign-owner --` on
Linux using a protected key file; this is owner authorization, not independent
security review. Focused checks: `test:production-rollout`; real isolated
database/HTTP rehearsal: `test:production-rollout:e2e` (required before production).

Developer-controlled no-email test account seeder:
[private configuration, verification and disable instructions](docs/runbooks/test-account-seeder.md).
Root commands: `test-accounts:seed`, `test-accounts:verify`, `test-accounts:disable`
(each takes `-- --config <absolute-private-file>`), and `test:account-seeder`.
Disabled by default; isolated non-production only; requires an existing approved
test Platform Owner and never changes existing passwords or bootstrap claims.

Isolated QA role kit: [inventory and matrix](docs/qa-role-permission-matrix.md),
[secure provisioning and manual login checklist](docs/runbooks/qa-role-test-kit.md).
`npm run qa:matrix` rebuilds the registry and generates the matrix;
`npm run test:qa-role-kit` runs focused provisioning safety tests;
`npm run qa:provision -- --activation-directory <private-directory>` is Linux-only,
requires an explicitly configured disposable loopback database and an existing
test-only Platform Owner bootstrap claim, and never rotates existing credentials.
Multi-tenant automated customer engagement SaaS. The first channel is **outbound
Voice in Uganda**.

> **Status: engineering foundation with organization RBAC and campaign records.**
> This branch adds the RBAC-007 Operations Admin console and campaign emergency
> stop. RBAC-004/005 remain in separate draft development work, and production
> payment collection, wallet settlement, voice dispatch, SMS, and customer
> notifications are not implemented. See
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

The platform-admin app provides an Operations console at `/admin` on this
branch. Its API independently enforces platform permissions. Emergency stop
pauses and locks an active campaign record; no voice provider or call dispatch
is connected. See [RBAC-007 implementation notes](./docs/rbac-007-operations-admin-progress-2026-10-20.md).
Supported non-production account activation is documented in
[the UAT runbook](./docs/runbooks/uat-account-provisioning.md). First-owner
bootstrap controls and separate production approval requirements are documented
in [the bootstrap runbook](./docs/runbooks/platform-owner-bootstrap.md).

Every Node workspace is an **ES module**, because NestJS 12 is published
ESM-only. See [ADR 0002](./docs/adr/0002-runtime-and-toolchain-versions.md).

```
truevine-voice/
├── apps/
│   ├── admin/          Platform-admin Operations console
│   ├── api/            NestJS REST API  -> GET /health
│   ├── web/            Customer web application (public marketing homepage)
│   └── worker/         Background worker (no business queues yet)
├── packages/
│   ├── auth/           [reserved] authentication, RBAC
│   ├── database/       Prisma schema, client, health probe
│   ├── domain/         money, phone numbers, call state/entity (pure)
│   ├── messaging/      [reserved] SMS / WhatsApp abstraction
│   ├── observability/  [reserved] logging, metrics, tracing
│   ├── payments/       [reserved] payments + immutable ledger
│   ├── pricing/        [reserved] plans, rating, price calculation
│   ├── queue/          Redis connection + BullMQ foundation
│   ├── shared/         env loading, health types, async helpers
│   ├── telephony/      Voice port + deterministic fake adapter
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

## RBAC-004 customer billing (development)

The customer Billing page at `/app/billing` supports wallet balance, paginated
transaction history, billing details, and pending top-up requests for OWNER and
BILLING memberships. API routes are organization-scoped and recheck permissions,
terms and CSRF. Amounts are UGX integer strings; balance is derived from an
append-only PostgreSQL ledger. A billing role grants no campaign/contact access.

**Payment collection is not integrated.** Requests remain pending and never
credit a wallet. Invoices and usage charging are not implemented. See
[ADR 0012](./docs/adr/0012-customer-billing-ledger.md). The additive RBAC-004 migration
is unapproved and must not be applied to production with this change.

`npm test` covers service/HTTP permission and customer-page tests without Docker.
`npm run test:billing:e2e` runs the focused real PostgreSQL billing journey
(also included in `npm run test:e2e`): use a disposable
loopback test database with the new migration applied, `NODE_ENV=test`, and
`BILLING_E2E_DISPOSABLE=1` (GitHub CI already uses disposable infrastructure).
Tests fail loudly if those requirements are missing. Do not point them at
production or a database whose test records cannot be discarded.

## W2-02 Increment 1 Contacts UI

`/app/contacts` lists organization contacts, searches name/phone/email across API
pages, and supports add, view, edit and eligible deletion. Navigation and controls
use the authenticated membership's permissions: OWNER, ADMIN and CAMPAIGN_MANAGER
can manage contacts; BILLING and VIEWER cannot access them. API guards remain
authoritative for session, current terms, CSRF, organization scope and permissions.
Phone numbers are normalized by the server and cannot be edited; name and email
can be updated. Suppressed and campaign-referenced contacts are retained by the API.
This increment adds no Groups, CSV import, consent management or call history UI.

`npm test` includes React DOM interaction tests using the pinned development-only
`happy-dom` dependency, route/navigation tests and Contacts HTTP guard tests.
The existing `npm run test:e2e` covers real PostgreSQL contact isolation and deletion
restrictions and requires the disposable infrastructure described below.

## RBAC-005 customer Viewer (development)

VIEWER memberships can open the organization dashboard, read campaign status and dates, and view a campaign status summary at `/app/reports`. API reads are scoped to the authorized organization and guarded by `campaign:read` or `reporting:read`; the role has no campaign, billing, wallet, organization, or membership write permission. Reports currently summarize campaign records only. Campaign execution, call outcomes, and performance reporting are not implemented.

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

Operator-only QA Owner recovery: `npm run recover:qa-owner -- --confirm-production --activation-directory <absolute-private-directory>`.
This replaces reset/activation tokens for the existing QA Owner only. See the
[private-file procedure and production approval boundary](docs/runbooks/qa-owner-recovery.md).
Run focused checks with `npm run test:qa-owner-recovery` and `npm run lint:qa-owner-recovery`.
The required CI E2E job runs `npm run test:qa-owner-recovery:linux` against a
new database on its disposable Linux Compose stack; this command refuses other environments.

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
| `npm run test:audio:e2e` | Audio tenant-key, foreign-tenant and append-only PostgreSQL checks |
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
| `npm run prisma:migrate:status` | Read migration-file and database ledger status; does not apply migrations |
| `npm run prisma:studio`         | Prisma Studio                                           |

> `npm run typecheck` and `npm run test` build `packages/*` first, because apps
> resolve `@truevine/*` through their built `dist` output.
>
> `npm run prisma:migrate:deploy` runs only in controlled environments. The protected
> deployment executes approved migrations before activation; see ADR 0011.

---

## Database

The Prisma schema holds the **tenancy core only**.

```prisma
model Organization { ... }   // unit of tenancy, unique immutable slug
model Membership   { ... }   // principal <-> organization, coarse role
enum MembershipRole { OWNER, ADMIN, OPERATOR, VIEWER }
```

`Contact`, `Campaign`, `Audio`, and billing data models exist in this checkout.
Audio metadata and append-only usage records are tenant-scoped; binary objects
stay in private object storage. Campaign records can select same-organization
audio, but campaign call execution remains disconnected. Money handling
(AGENTS.md 6-7) remains governed by the immutable wallet ledger.

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
| `AUDIO_STORAGE_BUCKET` | no | unset | Private S3-compatible bucket; enables recording uploads and playback |
| `AUDIO_STORAGE_REGION` | when bucket is set | — | S3-compatible region |
| `AUDIO_STORAGE_ENDPOINT` | no | AWS default | Optional S3-compatible endpoint |
| `AUDIO_STORAGE_FORCE_PATH_STYLE` | no | `false` | Path-style addressing for compatible S3 services |
| `AUDIO_TTS_REGION` | no | unset | AWS Polly region; enables speech synthesis |
| `POSTGRES_PORT`           | no       | `5432`        | Host port Compose publishes PostgreSQL on   |
| `REDIS_PORT`              | no       | `6379`        | Host port Compose publishes Redis on        |
| `LOG_LEVEL`               | no       | —             | `debug` enables extra Prisma client logging |

Configuration is validated at start-up. A missing required variable or a
malformed value **fails the boot** with an actionable message rather than
degrading silently at runtime. `.env` lives at the repository root and is
gitignored; `packages/*` and `apps/*` find it by walking up from the current
working directory.

Authentication secrets, Africa's Talking credentials and payment credentials
are not configured by these audio settings. S3 and Polly credentials must be
provided through the runtime AWS credential chain; they never belong in source.
Without storage configuration, audio mutations are unavailable. Without the
Polly region, the UI offers recording and upload but disables synthesis.

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

- **Product functionality:** Contacts, Campaigns, Wallet, Billing, Voice,
  SMS, WhatsApp, RBAC, authentication, admin functionality.
- **Africa's Talking adapter:** will be the first Voice provider, behind the
  `@truevine/telephony` interface. Not started. The `VoicePort` interface and a
  deterministic fake adapter exist; the Africa's Talking adapter, the webhook
  endpoint and callback signature verification are deferred. See
  [ADR 0017](./docs/adr/0017-provider-neutral-telephony-port-and-call-domain.md).
- **Call persistence and durable idempotency:** the pure `Call` entity and its
  state machine exist in `@truevine/domain`, but no `Call` database model,
  worker dispatch or idempotency-key uniqueness/replay does. Those belong to a
  later persistence/worker task.
- **Database models beyond tenancy:** Call, LedgerEntry. See
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
and PM2. Deploy applies approved migrations before activation; rollback changes code only.
They never reset Git or run development Compose. See [ADR 0011](./docs/adr/0011-reviewed-deployment-migrations.md).

## Isolated RBAC database CI

Run `npm run test:rbac-ci:checks` for workflow safety checks. See [isolated RBAC database CI](docs/rbac-database-ci-preparation.md) for disposable hosted billing/reporting E2E and the remaining release prerequisites. This does not approve migrations or deploy.

For non-production Operations Admin UAT, use the audited
`npm run provision:operations-admin-uat` command documented in [the UAT
account provisioning runbook](docs/runbooks/uat-account-provisioning.md). It
requires an isolated staging database, explicit opt-in, an active platform
owner, and a reviewed UAT request; it refuses production accounts.

## First Platform Owner bootstrap (local implementation; production approval withheld)

`npm run bootstrap:platform-owner -- --help` describes the operator-only command.
It creates a dedicated new platform identity with a private, single-use 24-hour
activation link, never a default password. Explicit environment opt-in and a
private, matching operator approval record are mandatory. Existing identities,
any prior Platform Owner assignment and a consumed bootstrap claim are refused.
There is no public bootstrap endpoint and deployment never runs the command.

See [ADR 0014](docs/adr/0014-first-platform-owner-bootstrap.md) and the
[operator runbook](docs/runbooks/platform-owner-bootstrap.md). The additive
`20261020180000_platform_owner_bootstrap` and
`20261020181000_platform_owner_bootstrap_no_truncate` and forward-hardening
`20261020182000_platform_owner_bootstrap_search_path` migrations are intentionally
absent from the production approval manifest. No production execution is
approved by this implementation.

`npm run test:platform-owner-bootstrap:e2e` runs the focused real PostgreSQL
suite. It creates and migrates fresh uniquely named databases, runs synthetic
bootstrap/activation/rollback/concurrency tests, then drops only databases that
invocation created. Local use requires `NODE_ENV=test`,
`BOOTSTRAP_E2E_DISPOSABLE=1` and `BOOTSTRAP_TEST_ADMIN_URL` supplied privately for
an exclusively disposable loopback PostgreSQL instance's `postgres` database.
Hosted full E2E uses the existing disposable CI service. The suite fails loudly
if neither safe target is available. Redis and real accounts are not required.

`npm run test:platform-owner-bootstrap:linux` additionally requires Linux and
checks actual private-file permissions, path protections and the CLI handoff.
The existing Linux Actions E2E job runs this gate with disposable services;
no production secrets are used. See the runbook for independently approved
production cluster-identity verification and private operator prerequisites.
`npm run test:platform-owner-bootstrap:unit` runs just the bootstrap unit suite;
its Windows refusal assertions do not establish Linux filesystem validation.

## Recipient and call persistence (development)

Internal services persist tenant contacts, immutable recipient snapshots, call
attempts and durable acceptance replay. W2-02 adds contact management and import
endpoints while retaining the existing contact IDs, destination/label fields and
campaign-recipient snapshots. No live provider, queue dispatch or charging is
enabled. See [ADR 0018](docs/adr/0018-call-recipient-persistence-and-idempotency.md).

- npm run test:call-persistence:e2e: focused real PostgreSQL contracts, also
  included in npm run test:e2e. Requires migrated disposable loopback PostgreSQL
  on port 55432, NODE_ENV=test and CALL_PERSISTENCE_DISPOSABLE=1 locally.
- npm run prisma:migrate:diff -- --from-schema <baseline> --to-schema <schema> --script:
  generate SQL for review only; preserve manually maintained integrity triggers.
- `npm run test:w2-02:migration`: GitHub Actions-only rehearsal against a temporary
  database replayed from the existing migrations; verifies legacy contact and
  recipient preservation plus transactional rollback.

Migration application to production and deployment remain separately authorized.

## RBAC-012 backend tenant isolation

See [the resource inventory and security review](docs/rbac-012-tenant-isolation.md) and
[ADR 0019](docs/adr/0019-tenant-isolation-write-authorization.md).
Campaign/billing writes recheck membership inside their database transaction.
Run `npm run test:tenant-isolation:e2e` on the disposable loopback test stack
with `NODE_ENV=test` and `TENANT_ISOLATION_DISPOSABLE=1` (or hosted CI).
The suite is also included in `npm run test:e2e` and `npm run test:security`;
missing infrastructure fails loudly. No frontend, migration or deployment change.

## RBAC-013 sensitive action audit (backend development)

The [assessment and coverage matrix](docs/rbac-013-sensitive-action-audit.md)
records supported sensitive mutations, transactional audit controls and limits.
Run `npm run test:sensitive-audit:e2e` against the disposable loopback stack with
`NODE_ENV=test` and `SENSITIVE_AUDIT_DISPOSABLE=1`, or hosted CI. The suite is also
included in ordinary E2E/security runs and fails loudly without infrastructure.
The additive audit-integrity migration remains unapproved for production.
No frontend, real financial operation, plan or provider execution is added.
