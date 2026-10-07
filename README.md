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
│   ├── web/            Customer web application (placeholder page)
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

## Setup

```bash
# 1. Use the pinned Node version
nvm use            # reads .nvmrc

# 2. Install dependencies
npm install

# 3. Create your local environment file
cp .env.example .env        # Windows PowerShell: Copy-Item .env.example .env

# 4. Start local infrastructure
npm run infra:up

# 5. Generate the Prisma client
npm run prisma:generate

# 6. Run everything
npm run dev
```

On Windows without `nvm`, install Node 24.19.0 directly. `npm install` fails
fast with a clear message if the runtime does not match `engines`.

### Ports

| Service    | Default port | How to change it                                  |
| ---------- | ------------ | ------------------------------------------------- |
| Web        | 3000         | `apps/web/package.json` → `dev`/`start` scripts   |
| API        | 3001         | `API_PORT` in `.env`                              |
| Admin      | 3002         | `apps/admin/package.json` → `dev`/`start` scripts |
| PostgreSQL | 5432         | `POSTGRES_PORT` in `.env` + `DATABASE_URL`        |
| Redis      | 6379         | `REDIS_PORT` in `.env` + `REDIS_URL`              |

The Next.js ports are hardcoded in each app's npm scripts rather than read from
the environment, because `${VAR:-default}` shell syntax does not work under
`cmd.exe` and would make the scripts Windows-only.

If your machine already runs PostgreSQL or Redis (for example via another
project's containers), set `POSTGRES_PORT` / `REDIS_PORT` in `.env` and point
`DATABASE_URL` / `REDIS_URL` at those ports before running `npm run infra:up`.

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

### Formatting

| Command                | Description              |
| ---------------------- | ------------------------ |
| `npm run format`       | Prettier write           |
| `npm run format:check` | Prettier check (CI gate) |

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

---

## Database

The Prisma schema is **intentionally empty**.

```prisma
generator client { ... }   // prisma-client generator -> src/generated/prisma
datasource db { ... }      // postgresql
```

There are **no models**. The domain model (Organization, Membership, Contact,
Campaign, Call, Wallet, LedgerEntry, ...) is designed deliberately in a later
task, with tenancy, money handling and idempotency agreed before any table
exists. Creating speculative tables now would bake in unreviewed decisions and
require destructive migrations to undo.

The generator exists so `prisma generate` produces a typed client, and health
probing uses `SELECT 1`, which works before any table is created. It uses the
Prisma 7 `prisma-client` generator (`prisma-client-js` is deprecated) with
`moduleFormat = "esm"` to match the repository's ESM-only Node workspaces.

The generated client (`packages/database/src/generated/`) is gitignored.

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
- **Database models:** none. See [Database](#database).
- **Business queues:** none. The worker establishes Redis/BullMQ connections and
  readiness only.
- **OpenAPI:** deferred until the first product endpoints exist.
- **CI (GitHub Actions):** deferred. The scripts a pipeline needs are already in
  `package.json`; see [`.github/workflows/README.md`](./.github/workflows/README.md).
- **Production infrastructure:** container images, orchestrator manifests,
  infrastructure-as-code. There is no deployment target yet.
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
