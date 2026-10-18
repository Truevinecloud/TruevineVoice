# RBAC-002 staging verification plan

What to run, in what order, to verify the **Organization Admin** change on a
staging machine — and what each run proves. Execute the whole plan **before**
merging the pull request; nothing here creates a production account.

## 0. What this change is, and therefore what can break

| Surface                                         | Changed by RBAC-002            |
| ----------------------------------------------- | ------------------------------ |
| `OrganizationsService.removeMember` delegation  | **Yes** — behaviour change     |
| Database schema / migrations                    | No                             |
| HTTP routes, guards, status codes               | No                             |
| Permission registry (`permissions.ts`)          | No (ADMIN was already defined) |
| Tests (guard matrix, service rows, route audit) | Yes                            |
| Docs (provisioning runbook, this plan)          | Yes                            |

Because no schema and no route changed, the risk is **behavioural**: an
organization admin must now be able to remove a campaign manager or viewer, and
still be refused when the target is a peer admin, an owner or a billing member.
Stage E is the only stage that exercises exactly that over HTTP.

## 1. Preconditions

- A Linux host (or Windows with Docker Desktop) where `docker` is on `PATH` and
  `docker compose` can start the repository stack.
- Repository checkout plus `npm ci`, `npm run prisma:generate`.
- `.env` copied from `.env.example` (gitignored). `EMAIL_TRANSPORT=development`
  keeps mail in `./.email-capture/`.
- **No production credentials in the environment.** The security harness refuses
  a `DATABASE_URL` that is not loopback:55432; do not work around that.

```bash
npm ci
npm run prisma:generate
docker compose up -d --wait     # or: npm run infra:up
```

## 2. Stage A — static and unit gates (fast, run first)

```bash
npm run lint
npm run typecheck
npm test
npm run build
```

Expected: `lint` and `typecheck` clean; `npm test` green (api 161 tests / 6
files, auth 77, web 66, admin 3, worker 5, database 5, messaging 5, queue 5,
deployment 142 passed + 3 skipped POSIX-only); `build` produces all four apps.

Also confirm the touched files are Prettier-clean:

```bash
npx prettier --check \
  apps/api/src/organizations/organizations.service.ts \
  apps/api/test/auth.service.spec.ts \
  apps/api/test/authorization.guard.spec.ts \
  apps/api/test/route-guards.spec.ts \
  packages/auth/src/permissions.spec.ts \
  docs/runbooks/*.md
```

`npm run format:check` is **not** a CI gate; on a Windows checkout it flags every
CRLF file (237 at the time of writing) including three documents known to be
unformatted on Linux (`apps/api/test/health.infrastructure.e2e-spec.ts`,
`apps/worker/test/worker.e2e-spec.ts`, `README.md`). Judge Stage A by the file
list above, not by a repo-wide `format:check` on Windows.

## 3. Stage B — end-to-end suites

CI runs these on every pull request (`.github/workflows/ci.yml`, job `e2e`) with
the Compose stack, so a staging run is a pre-flight confirmation rather than the
first execution.

```bash
docker compose up -d --wait
npm run prisma:migrate:deploy
npm run build:packages && npm run build:api
npm run test:e2e
docker compose down --volumes
```

Required environment: `DATABASE_URL` (loopback, port `55432`) and `REDIS_URL`
(port `56379`), matching `.env.example`.

- `@truevine/database` — tenancy, identity and provisioning specs against live
  PostgreSQL (`provisioning.e2e-spec.ts` is the DB half of secure activation).
- `@truevine/api` — HTTP authorization and tenant isolation
  (`authorization.e2e-spec.ts`), the ADMIN allow/deny matrix over HTTP
  (`organization-admin.e2e-spec.ts`, added by RBAC-002), the RBAC-001 security
  remediations, and the health probe that fails loudly when infrastructure is
  absent.
- `@truevine/worker` — Redis reachability through a real process restart.

Constraint worth knowing: `security-remediation.e2e-spec.ts` refuses to run
unless the database name starts with `rbac_security_` or `CI=true`. Run it
through `npm run test:security` (Stage C) rather than pointing `test:e2e` at an
arbitrary database.

`organization-admin.e2e-spec.ts` enforces a narrower guard of its own: it refuses
to connect unless `DATABASE_URL` is loopback on port `55432` and `NODE_ENV` is
not `production`, so it can never be aimed at a shared database by accident. This
matches the CI e2e job's environment exactly, so it runs there with no workflow
change; locally it needs the compose stack from Stage B.

**Coverage this plan no longer depends on a human for:** the committed e2e suite
now drives the organization routes both as an **owner** (positive controls) and
as an **admin** (`organization-admin.e2e-spec.ts`, covering member removal,
the two escalation refusals and cross-tenant access). Stage E remains for the
things a test cannot do: confirming the behaviour through a real browser session
and recording evidence for a release decision.

## 3b. Stage C — security suite

```bash
npm run test:security             # creates rbac_security_* disposable databases
npm run test:security:baseline    # expected to fail by design; record the output
```

Requirements, all enforced by the harness itself: loopback `DATABASE_URL` on
port `55432`, a running container named `truevine-postgres`, and `docker` on
`PATH`. It creates throwaway databases named `rbac_security_<ts>_<pid>*`, applies
migrations up to the security-atomicity boundary, then the remediation
migrations, and drops what it created. Every database it creates is dropped in a
`finally` block, and the drop is preceded by a name check (`rbac_security_…` with
the run's own timestamp and pid) so it cannot delete a database it did not create.

**It is a CI gate.** The `e2e` job in `.github/workflows/ci.yml` runs
`npm run test:security` after the migrations step and before teardown, against
the same disposable Compose stack. CI therefore exercises the remediation
suites as well as the tenancy and admin suites; the local steps above exist for
a developer reproducing a CI failure.

## 4. Stage D — live boundary verifiers

| Command                     | Needs                                                     | Proves                                                                                                                                         |
| --------------------------- | --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run verify:journey`    | `WEB` (default `http://localhost:3000`) with api + web up | the whole activation journey: provision → activate → sign-in → terms → invite → accept, step by step                                           |
| `npm run verify:boundaries` | API on `http://localhost:3001`, `docker`/psql             | tenant boundaries, CSRF, cookie flags, audit trail for two independent organizations                                                           |
| `npm run verify:frontend`   | `WEB`, **`OWNER_EMAIL` + `OWNER_PASSWORD`**               | server-rendered pages, same-origin proxy, cookie/CSRF behaviour through the frontend origin (fails loudly if the credentials are not supplied) |
| `npm run test:rehearsal`    | Linux + container runtime (skip elsewhere)                | migration rehearsal with adversarial profiles                                                                                                  |

These scripts provision their own run-scoped throwaway organizations. They
contain throwaway passphrase constants for their disposable accounts by design;
no credential for a real account exists in any of them.

## 5. Stage E — secure accounts and the admin matrix over HTTP

Follow `docs/runbooks/test-account-provisioning.md` to create, on staging only:

1. an **Owner** of a target organization (`npm run provision:owner`, then consume
   the single-use activation link);
2. an **Admin** and a **Viewer** identity (each provisioned as owner of its own
   throwaway organization, activated, then invited into the target organization
   and accepted);
3. at least one **peer Admin**, one **Billing** and a second **Owner** (create a
   second owner via `POST /organizations/{id}/ownership/transfer`, never via an
   invitation).

Sign each account in and `POST /auth/terms/accept`, then exercise the matrix.
`member:remove` is `DELETE /organizations/{organizationId}/members/{userId}`.

### Removal matrix (the change under test)

| Actor   | Target           | Expected                                                    |
| ------- | ---------------- | ----------------------------------------------------------- |
| ADMIN   | VIEWER           | **204** — the regression the fix repairs                    |
| ADMIN   | CAMPAIGN_MANAGER | **204**                                                     |
| ADMIN   | peer ADMIN       | **403** `cannot_delegate_beyond_own_authority`              |
| ADMIN   | OWNER            | **403**                                                     |
| ADMIN   | BILLING          | **403**                                                     |
| ADMIN   | self             | **403**                                                     |
| OWNER   | ADMIN            | **204** — owner privileges preserved                        |
| OWNER   | BILLING          | **204** — owner privileges preserved                        |
| OWNER   | other OWNER      | **204** while one owner remains; **409** for the last owner |
| VIEWER  | anyone           | **403**                                                     |
| BILLING | anyone           | **403**                                                     |

### Other admin boundaries

| Actor | Request                                                    | Expected                                   |
| ----- | ---------------------------------------------------------- | ------------------------------------------ |
| ADMIN | `POST /organizations/{id}/ownership/transfer`              | **403**                                    |
| ADMIN | `PATCH /organizations/{id}/members/{other}` role → `OWNER` | **403**                                    |
| ADMIN | invite `OWNER` or `BILLING`                                | **403**, no invitation row created         |
| ADMIN | `GET /organizations/{otherTenantId}`                       | **403**, audited against the probed tenant |
| ADMIN | any billing/wallet route                                   | **403** — no such route is implemented yet |
| ADMIN | any `/platform/*` route                                    | **404** — no platform HTTP surface exists  |

### Audit rows written (read-only inspection)

```bash
docker exec truevine-postgres psql -U truevine -d truevine_voice -tAc \
  "SELECT action, outcome, metadata FROM security_audit_events ORDER BY occurred_at DESC LIMIT 20;"
```

Expect a `security_audit_events` row for every refusal above, with
`action = 'authorization.denied'` and the probed `organization_id`; and for a
successful removal `organization.member.removed` with outcome `SUCCESS`. Never
`SELECT *` in shared output — the trail is retained indefinitely and read by
support.

## 6. Evidence to capture

- Exit status and the last lines of `lint`, `typecheck`, `test`, `build`,
  `test:e2e`, `test:security`.
- The PASS/FAIL lines from `verify:journey`, `verify:boundaries`,
  `verify:frontend`.
- The Stage E result per row, plus the audit rows for the ADMIN refusals.
- `docker compose down --volumes` output showing the stack was discarded.

No passphrase, activation token or invitation link belongs in any of it.

## 6b. Go / no-go

Merge is a yes when every row in stages A–E passes. A `test:security:baseline`
failure is expected and is not a blocker; an unexpected one is. If Stage E shows
an ADMIN succeeding where the matrix says 403, stop: that is a privilege
escalation and the change must not be merged.

## 7. Rollback

No migration and no route change, so rollback is reverting the single
`removeMember` hunk; the pre-change behaviour (an admin able to remove nobody) is
safe but wrong. If the change is only partially wanted, the registry row is the
lever: removing `member:remove` from `ADMIN` disables admin removal entirely
without touching the service.

## 8. Out of scope

Creating accounts on production, deploying, or exercising contacts, campaigns,
audio, wallet, billing or platform-admin surfaces — none of which exist yet.
