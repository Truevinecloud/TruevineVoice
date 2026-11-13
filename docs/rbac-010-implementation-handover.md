# RBAC-010 Technical Admin — implementation handover

Date: 2026-11-12. **Not complete: browser verification and GitHub delivery are pending.**

## Local-only continuation — 2026-11-13

This section supersedes the historical verification status below. The authorized
workflow is develop, debug, test locally, commit, then push the feature branch.
No CI/CD, deployment, hosting or infrastructure configuration is in scope.

### Changes made during this continuation

- `.gitignore`: narrowly unignore the Technical Admin Logs route, which the
  broad `logs/` rule previously hid; ignore private bootstrap approval files.
- `apps/admin/src/app/PlatformShell.tsx`: report logout failures, retain the
  visible session on failure and allow a retry instead of pretending logout succeeded.
- `apps/admin/src/app/PlatformShell.session.spec.tsx`: test failed logout and
  successful retry, including redirect and navigation refresh.
- `apps/admin/src/app/technical/audit/page.tsx`: add refresh using the applied
  filter; distinguish restricted/unknown actions and inaccessible cursors from
  missing role access; offer filter recovery.
- `apps/admin/src/app/technical/technical-resource.tsx`: correct loading copy.
- `apps/admin/src/app/technical/technical-pages.spec.tsx`: cover query error
  recovery and cancellation of stale diagnostics after navigation.
- `apps/admin/src/app/technical/logs/page.tsx`: make the existing local page
  visible to Git and format it. It is required by the page tests and navigation.
- `apps/api/test/support.e2e-spec.ts`: remove four silent cleanup catches.
  Retain audited fixture records to respect immutable audit foreign keys and
  last-owner constraints; transactionally remove ephemeral access state only.
  Cleanup errors fail the suite, and shutdown/disconnect run in finally blocks.
- `apps/api/test/technical.e2e-spec.ts`: likewise close resources on cleanup
  failure and never attempt cleanup writes before connected-database verification.
- `create-qa-fixture.mjs` and `scripts/seed-test-accounts.mjs`: fix their lint
  errors without disabling lint rules, remove hard-coded password/connection
  defaults and avoid printing raw failure objects. These pre-existing untracked
  provisioning scripts were **not executed** and are excluded from task delivery;
  this is not a claim that their provisioning safety has been verified.
- `docs/rbac-010-implementation-handover.md`: record this continuation.

Other pre-existing edits remain in place. No credentials were used from source
code, no passwords were reset, and no account or role was created.

### Commands and results, in execution order

Inspection reads (`Get-Content`, `rg`, `git status`, `git diff`, `git log`,
`git branch`, `git remote`, `git check-ignore`) are grouped. No secret-bearing
configuration content is included here.

1. Inspected repository instructions, README, ADR 0015, existing implementation,
   tests, handover and dirty branch; read Next.js client-component documentation
   and computer-use instructions. Corrected a few unsuccessful filename lookups.
2. Applied the Support cleanup correction and untracked-script lint corrections.
3. `npm.cmd run lint`: exit 0, zero errors and one existing Billing effect
   dependency warning (`apps/admin/src/app/billing/page.tsx:124`).
4. Sanitized Node environment inspection: `.env` and `.env.backup` name the
   shared `truevine_voice` database, not the named bootstrap QA database.
   An initial inline Node invocation had a quoting error; the corrected stdin
   invocation printed only database host/name/port and matching key names.
5. Read-only Node/Prisma connection attempt to the documented isolated QA
   database failed. Repeated with approved sandbox escalation: `ECONNREFUSED`.
6. `docker compose ps`: sandbox denied Docker pipe access; approved escalated
   retry passed. Existing PostgreSQL and Redis containers are healthy, but
   PostgreSQL has **no host port mapping**. No container was changed or restarted.
7. Added frontend fixes/tests. `npm.cmd run test --workspace @truevine/admin`:
   **100 passed**. Scoped `npm.cmd exec -- prettier --write ...` completed.
8. Approved read-only `docker exec ... psql ...` check: database is exactly
   `truevine_bootstrap_test_a1b2c3d4e5f67890`; platform role counts are one
   PLATFORM_OWNER and one SUPPORT_ADMIN, with **no TECHNICAL_ADMIN assignment**.
9. `npm.cmd run typecheck`: passed all configured workspaces.
10. `npm.cmd run test --workspaces --if-present -- --maxWorkers=2`: **1,531
    passed**, no failures. Admin 100; API 860; web 317; worker 5; audio 7; auth
    113; database 5; domain 58; messaging 21; queue 8; shared 19; telephony 18.
    This includes in-process HTTP integration/guard tests with fake persistence.
    Expected audit-failure tests emit fail-closed diagnostics. No timeout,
    assertion, lint rule or test was weakened. Root `npm test` was deliberately
    not used because it chains the deployment verification suite.
11. Browser discovery through computer use failed twice: browser host unavailable
    and native pipe unavailable. No browser page or authenticated flow was verified.
12. Corrected the ignored Logs route and private approval ignore; repeated
    `npm.cmd run lint`: passed with the same single existing Billing warning.
13. `npm.cmd run build`: passed packages, API, worker, customer web and admin.
    Output includes overview/providers/queues/logs/audit technical routes.
14. Added final Technical E2E teardown safeguard. Subsequent
    `npm.cmd run typecheck --workspace @truevine/api`: **passed**.
15. Started `npm.cmd run start:api` with process-only local development overrides:
    API `127.0.0.1:3003`, documented isolated QA database name, email transport
    `none`. No `.env` was modified and no credentials/connection URLs were printed.
16. Started `npm.cmd run dev --workspace @truevine/admin -- --port 3004 --hostname
    127.0.0.1` with `TRUEVINE_API_URL=http://127.0.0.1:3003` in the process
    environment. Ready at `http://127.0.0.1:3004/admin`.
17. Local HTTP probes: API health **503**, PostgreSQL down, Redis up;
    unauthenticated technical reads **401**. Admin root and all five technical
    pages **200** with the application shell; all six technical proxy reads
    **401** without a session. The deliberately non-allowlisted proxy
    `/auth/terms` returns **404**. The actual login discovery route
    `/platform/operations/me` returns **401** and issues the CSRF cookie without
    Secure on local development HTTP. No cookie values were printed.
18. `git diff --check`: passed. Git still reports existing global-ignore access
    and LF/CRLF normalization warnings. No staging, commit or push has occurred.
19. Final `npm.cmd exec -- eslint` scoped to the modified shell, Technical Admin
    pages/tests, Support/Technical E2E files and the two untracked scripts:
    **passed with no warnings or errors**. Final `git diff --check`: passed.

### Outstanding local gates

- Authorized private QA connection/access details are pending. The API is
  configured for the documented QA database but **not connected**. No
  database-backed test was run against an unverified target.
- The fixture-writing E2E allowlist does not accept the documented bootstrap QA
  database name. It has not been widened. These suites require an existing
  authorized disposable target accepted by that guard.
- Authorized browser credentials/access for Technical Admin, Platform Owner and
  Support Admin were requested. Source-code passwords were not used. Browser
  control must also be restored before login, navigation, privacy and logout
  checks can be claimed.
- Diff review found pre-existing Support E2E edits removing wallet/top-up
  fixtures and replacing meaningful diagnostics expectations with empty arrays.
  The user was asked whether to restore that coverage; it remains unchanged
  pending the explicit decision required by AGENTS.md.
- The verified task file selection, commit and GitHub push remain pending these
  local gates. No commit hash or published feature-branch URL is claimed.

### Final local run — 2026-11-13 (live QA database, port conflict, delivery)

This run supersedes the outstanding-gate status above where the two disagree.

Root causes found and fixed:

- `EADDRINUSE` on port 3001 came from two concurrent
  `npm run dev --workspace @truevine/api` watcher chains. Only those Truevine
  API processes were stopped; the admin frontend and unrelated Node processes
  were untouched. One API was then started on `127.0.0.1:3001`.
- The running API was given a **process-level** `DATABASE_URL` whose database
  name was rewritten to the isolated QA database, preserving every other URL
  parameter. `.env` was not modified and no URL, password or token was printed.
  The effective database was verified through `pg_stat_activity`, not merely
  from configuration: sessions are on
  `truevine_bootstrap_test_a1b2c3d4e5f67890`.
- Local sign-in failures had two contributing causes. First, the admin proxy
  allowlist rejected `/platform/support/overview`, so the Support workspace
  received a proxy 404 after a successful sign-in; it is now allowed. Second,
  the session and CSRF cookies were `secure: true` unconditionally, so a
  browser on plain-HTTP local development discarded the session cookie and the
  next request looked unauthenticated. Cookie options are now environment
  dependent: `secure` in every non-development environment, non-`secure` only
  in development. Production behaviour is unchanged.

Verification performed in this run:

1. `npm.cmd run build:packages` and `npm.cmd run build:api`: passed.
2. Live API `GET /health`: **200**, PostgreSQL and Redis **up**.
3. Focused API suite (`technical.http.spec.ts`, `technical.service.spec.ts`,
   `prisma-technical.store.spec.ts`, `authorization.guard.spec.ts`,
   `cookies.spec.ts`): **366 passed**, exit code 0. The logged
   `audit unavailable` diagnostics come from the fail-closed tests.
4. `npm.cmd run test --workspace @truevine/admin`: **100 passed**, exit 0.
5. Admin routes against the live server: `/admin`, `/admin/technical` and
   `/admin/technical/{providers,queues,logs,audit}` **200**;
   `/admin/platform/operations` **404** because Operations is `/admin`.
6. Unauthenticated API reads `/platform/technical/{me,overview,providers,queues,logs,audit}`
   **401**; `POST`/`PUT`/`DELETE` on technical paths **404**, so no mutation
   route exists. The same reads through the admin proxy are **401**, a
   technical `POST` through the proxy is **404**, and
   `/admin/api/platform/support/overview` now reaches the API (**401**) instead
   of the proxy 404.
7. CSRF cookie issued over local HTTP has no `Secure` attribute; a sign-in
   without the CSRF header is **403**, with it an unknown account is **401**.
8. `npm.cmd run lint`: exit 0, zero errors, one existing Billing effect
   dependency warning (`apps/admin/src/app/billing/page.tsx:124`). The earlier
   claim that repository-wide lint was red no longer holds.
9. `npm.cmd run typecheck`: exit 0 for all workspaces.
10. `npm.cmd run build`: exit 0 for packages, API, worker, customer web and
    admin; the admin route list includes all five technical pages.

Still not verified, and why:

- Authenticated Technical Admin, Platform Owner and Support Admin journeys were
  **not** performed. Both QA platform accounts are `ACTIVE`, unlocked with zero
  failed attempts and correct roles, so account state is not the blocker; the
  local candidate credentials that exist on this machine do not match the
  stored hashes. No password was reset, no session was minted and no account or
  role was created.
- No `TECHNICAL_ADMIN` assignment exists in the QA database, so a real-role
  Technical Admin journey would additionally require unauthorized provisioning.
- The database-writing technical E2E suite remains blocked by the disposable
  database allowlist, which was not widened.
- `apps/api/test/support.e2e-spec.ts` is **not** included in this delivery. It
  still removes wallet/top-up fixtures and asserts empty diagnostics where the
  committed test asserted a real balance and top-up count. Restoring that
  coverage is a coverage decision that has not been authorised, so it was left
  unchanged and uncommitted rather than shipped.
- An unused `DATABASE_TRANSACTION_TIMEOUT_MS` option in
  `packages/database/src/index.ts` and its factory call site were left
  uncommitted: nothing reads it, no documentation describes it, and it is
  outside RBAC-010 scope.
- `create-qa-fixture.mjs`, `scripts/seed-test-accounts.mjs`, `.kilo/` and an
  empty stray file named `{` were not committed.

## Implementation

The existing read-only technical backend is reused. Technical Admin audit reads
now restrict both database queries and cursor anchors to `platform.*` actions;
security events additionally require PLATFORM scope. Non-platform action filters
return 403; inaccessible cursor anchors return 404. The role-specific response
allowlists only `id`, `trail`, `action`, `outcome`, `scope`, `occurredAt`. It
excludes actor identities, emails, target identifiers and raw metadata. Audit
records are preserved. Other authorized roles retain their existing projections.

The platform guard blocks Technical Admin from alternate general and Support
audit routes that previously accepted its shared audit permission. The role
still holds exactly technical-read and audit-read permissions. No financial,
credential, role-management or technical mutation authority was added.

The frontend provides overview/dependency diagnostics with probe latency,
declared providers, queues/jobs availability, a new Logs availability page,
and a paginated audit trail. It includes accessible loading messages, refresh,
retry, cancellation of stale requests, stable applied-filter pagination and
responsive navigation/tables. General Auditor navigation is hidden for this
role because the backend now forbids that alternate access path.

All existing GET `/platform/technical/{me,overview,providers,queues,logs,audit}`
endpoints are reused. No endpoint, database migration, provider integration,
business queue, log store, credential change or external paid operation was added.
Unavailable searches, filters, retries, recovery and live connectivity tests are
explained explicitly. ADR 0015 and the permission matrix record the approved
privacy decision.

## Task files

Created:

- `apps/admin/src/app/PlatformShell.session.spec.tsx`
- `apps/admin/src/app/api/technical-proxy.spec.ts`
- `apps/admin/src/app/technical/layout.tsx`
- `apps/admin/src/app/technical/logs/page.tsx`
- `apps/admin/src/app/technical/technical-pages.spec.tsx`
- `apps/admin/src/app/technical/technical-resource.tsx`
- `apps/admin/src/app/technical/technical.css`
- `apps/admin/src/lib/admin-config.spec.ts`
- `apps/api/test/technical.http.spec.ts`
- `docs/rbac-010-implementation-handover.md`

Modified:

- `.gitignore`
- `README.md`
- `apps/admin/next.config.ts`
- `apps/admin/src/app/PlatformShell.tsx`
- `apps/admin/src/app/PlatformShell.spec.ts`
- `apps/admin/src/app/api/[...path]/route.ts`
- `apps/admin/src/app/operations-dashboard.tsx`
- `apps/admin/src/app/operations-dashboard.spec.tsx`
- `apps/admin/src/app/technical/page.tsx`
- `apps/admin/src/app/technical/providers/page.tsx`
- `apps/admin/src/app/technical/queues/page.tsx`
- `apps/admin/src/app/technical/audit/page.tsx`
- `apps/admin/src/app/technical/technical-ui.tsx`
- `apps/admin/src/app/technical/technical-ui.spec.tsx`
- `apps/api/src/auth/auth.controller.ts`
- `apps/api/src/auth/auth.module.ts`
- `apps/api/src/auth/cookies.ts`
- `apps/api/src/auth/csrf-token.middleware.ts`
- `apps/api/src/auth/organization.guard.ts`
- `apps/api/src/technical/technical.controller.ts`
- `apps/api/src/technical/technical.service.ts`
- `apps/api/src/technical/technical.service.spec.ts`
- `apps/api/src/technical/technical.store.ts`
- `apps/api/src/technical/prisma-technical.store.ts`
- `apps/api/src/technical/prisma-technical.store.spec.ts`
- `apps/api/test/authorization.guard.spec.ts`
- `apps/api/test/cookies.spec.ts`
- `apps/api/test/technical.e2e-spec.ts`
- `docs/adr/0015-read-only-technical-admin.md`
- `docs/qa-role-permission-matrix.md` (also contained pre-existing changes)

Excluded from this delivery, and left uncommitted: `apps/api/test/support.e2e-spec.ts`,
`packages/database/src/index.ts`, `apps/api/src/infrastructure/infrastructure.module.ts`,
`create-qa-fixture.mjs`, `scripts/seed-test-accounts.mjs`, `.kilo/` and the stray
empty file `{`. No production data or password was changed.

## Commands and verification, in execution order

Repeated inspection reads are grouped. Temporary diagnostic scripts never print
credentials or database URLs.

1. `Get-Content`, `rg`, `git status --short`, `git branch --show-current`:
   inspected existing code, tests, ADRs, permission matrix and dirty main tree.
2. `git switch -c feat/rbac-010-technical-admin`: sandbox could not write Git refs;
   repeated with approved escalation and succeeded. Existing changes remained.
3. Next.js bundled client-component guide and computer-use skill/docs were read.
   Exploratory reads of a nonexistent lowercase shell filename and an incorrectly
   quoted command failed; corrected reads were used. No edit depended on them.
4. `Get-NetTCPConnection`, HTTP probes for ports 3003/3004 and process inspection:
   no reachable QA HTTP service; process inventory was access-denied.
5. A sanitized Node environment inspection identified `.env` as targeting
   `truevine_voice`, not the requested QA database. It was not rewritten.
6. `npm run lint` / `npm run typecheck`: PowerShell blocked `npm.ps1`;
   subsequent commands used `npm.cmd` without changing execution policy.
7. `npm.cmd run lint`: failed, 29 unrelated errors and one existing warning.
   Errors: four empty catch blocks in pre-existing `support.e2e-spec.ts` edits,
   eleven violations in untracked `create-qa-fixture.mjs`, fourteen in untracked
   `scripts/seed-test-accounts.mjs`. Warning: Billing page effect dependency.
8. `npm.cmd run typecheck`: passed across all configured workspaces.
9. `npm.cmd run test --workspace @truevine/api -- technical.http.spec.ts technical.service.spec.ts prisma-technical.store.spec.ts authorization.guard.spec.ts`:
   first run 356 passed / two failed. Corrected the health fake's missing
   environment and gave the cold-start HTTP setup a 15-second timeout. Rerun:
   358 passed. Added alternate-route guard coverage; final rerun: **361 passed**.
10. `npm.cmd run test --workspace @truevine/admin`: **95 passed**; repeated after
    final frontend changes with the same result.
11. Native Chrome verification was attempted. Browser host discovery failed;
    native access recovered, but navigation encountered `Cannot call write after
    a stream was destroyed`. Computer Use then reported the user pressed Escape.
    No further browser controls were called. No browser flow is claimed passed.
12. `npm.cmd run build`: passed for packages, API, worker, customer web and admin;
    output includes `/technical/logs` and the other technical routes.
13. Read-only Node/Prisma connection check: connected database exactly
    `truevine_bootstrap_test_a1b2c3d4e5f67890`. This does not establish the
    database used by a running API, because that API was unreachable.
14. `npm.cmd test`: **1,843 passed, three pre-existing platform-dependent skips**.
    API 857; admin 95; web 317; worker 5; audio 7; auth 113; database 5; domain 58;
    messaging 21; queue 8; shared 19; telephony 18; infrastructure 320.
    POSIX db-verify and backup runtime runners reported existing Windows skips.
    This full run preceded the final three additional guard tests, which passed
    in the focused rerun. No test was removed, skipped or weakened for this task.
15. `npm.cmd exec -- prettier --write` scoped to task files: completed. Incidental
    formatting of previously untouched technical files was restored.
16. `git diff --check`, task diff/status review: no whitespace errors. Git reports
    existing global-ignore access and LF/CRLF normalization warnings.
17. `npm.cmd run lint -- <task paths>` still included the root script's `.` and
    therefore repeated the unrelated failures. Correct scoped verification:
    `npm.cmd exec -- eslint <task paths>` — **passed, no output**.
18. Read-only real PostgreSQL check using the built `PrismaTechnicalStore`:
    **passed**. Eleven returned events met platform-action/scope restrictions;
    a non-platform action filter returned no records; an existing customer
    identity cursor was refused with **404**. No fixture or audit record was written.
19. Final `npm.cmd run typecheck` and `npm.cmd run build --workspace @truevine/admin`:
    results recorded below after completion.

Expected failure-path tests emit unavailable-audit diagnostics; these are tested
fail-closed responses, not hidden test failures. In-process HTTP tests verify
200 for allowed reads, 401 without a session, 403 for alternate audit, customer
financial, platform billing and role-management routes, 404 for nonexistent
technical mutations, and 500 when a diagnostic read cannot be audited.

## Remaining gates and Git delivery

- Technical Admin browser sign-in, landing, navigation, filters, refresh,
  logout, real API denial statuses, and Platform Owner/Support login regression
  checks are **not verified**. Authorized QA credentials were requested; no
  credentials were invented and no existing account was reset.
- The specified QA HTTP services were unreachable. Browser control was stopped
  by the user. No exact browser HTTP response status exists for those attempts.
- The database-writing technical E2E suite was updated but not run against the
  QA database: its existing disposable-database guard does not allow the named
  bootstrap QA database. That safeguard was not relaxed. The real read-only
  PostgreSQL check above is narrower than a complete authenticated E2E journey.
- Repository-wide lint remains red on unrelated files. Scoped task lint is clean.
- Branch: `feat/rbac-010-technical-admin`. No task commit, staging or GitHub push
  has been made: requested successful-verification gates remain unmet. No
  deployment, password reset, force-push or Git history rewrite was performed.
- Business job processing, live providers, queryable logs, incident storage and
  operational mutations remain deferred because their backing capabilities do
  not exist and the approved Technical Admin role is strictly read-only.
