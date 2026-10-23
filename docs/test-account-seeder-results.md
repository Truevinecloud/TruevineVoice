# Test Account Seeder verification — 2026-10-23

Implemented locally on `feat/qa-role-test-kit` at base `0480655`, preserving all existing QA kit work. The requested live deployment/account outcome is **not achieved**: no code was pushed/deployed and no live accounts were created, inspected or authenticated. The repository classifies `https://voice.truevinecloud.online` as production; the request calls it development. An environment/authorization clarification was requested, and that classification remains unresolved. The seeder rejects that host and production NODE_ENV and has no production override.

## Files created or changed for this request

- `infrastructure/scripts/test-account-seeder.mjs`: protected-file-only, disabled-by-default seed/verify/disable CLI; strict disposable target validation; connected database-name check; serializable transaction/advisory lock; existing approved owner verification; organization/account audit provenance; direct Argon2id credential creation; exact scope checks and non-secret reporting.
- `infrastructure/scripts/test-account-seeder.spec.ts`: sixteen automated cases covering target refusal, minimum/maximum policy through the existing validator, distinct inventory passwords, exact roles, actual Argon2id verification, idempotency, credential/role/tenant/provenance conflicts, immutable owner prerequisite, preservation, disable/session/token handling, and AuthService sign-ins/denials. The explicit weak-password case covers minimum length; the shared password-policy suite covers maximum/blank cases.
- `packages/auth/src/audit.ts`: three explicit audit actions for organization creation, account creation and disable.
- `package.json`: `test:account-seeder`, `test-accounts:seed`, `test-accounts:verify`, `test-accounts:disable`.
- `README.md`: links and root commands.
- `docs/runbooks/test-account-seeder.md`: exact configuration/execution instructions, inventory, login and disable procedure, deployment boundaries and owner limitation.
- `docs/test-account-seeder-results.md`: this report.

All other modified/untracked QA kit files predate this request and were retained. No Prisma schema, migrations, bootstrap implementation or CI/CD workflow changed. No dependencies or test skips added.

## Commands executed, in order

1. `git status --short --branch`, README/AGENTS/source reads, `rg` password-policy/auth/schema searches, bootstrap and ADR 0014 reads: confirmed existing architecture, 12–200 character policy, Argon2id implementation, ACTIVE/SUSPENDED lifecycle, immutable owner claim and production restriction. Some combined output was truncated; targeted follow-up reads supplied private-file and authentication details.
2. Targeted bootstrap reader/auth tests/permission exports/CI deployment/ADR reads: confirmed the existing secure Linux reader and human-authorized production workflow. That workflow was not dispatched.
3. `npm.cmd run build:packages`: passed after adding audit vocabulary.
4. `npm.cmd run test:account-seeder`: initially 15 passed; after adding fake-backed AuthService authentication/disable checks, **16 passed**. Passwords for these tests are random in-memory values, never operator or live credentials.
5. `npm.cmd run lint`: **passed** with no lint warnings/errors.
6. `npm.cmd test`: **passed**. API: 617 tests; infrastructure: 269 passed, three pre-existing Windows skips. Remaining workspace counts: admin 43, web 141, worker 5, auth 111, database 5, domain 58, messaging 21, queue 8, shared 19, telephony 18. Existing Linux-only database-verification and backup runtime scripts explicitly skipped on Windows. Expected failure-path audit/Redis diagnostic messages appeared. Nothing was suppressed or weakened.
7. `npm.cmd run typecheck`: **passed** across configured workspaces. The existing root typecheck covers application/package TypeScript, not standalone infrastructure tests; Vitest transforms and ESLint checks those tests.
8. `git diff --check`, `git status --short --branch`, audit-file inspection and package-script search: no whitespace errors, intended changes retained. An exploratory `Get-Content packages/auth/src/audit.spec.ts` failed because that path does not exist; the full auth workspace suite passed.
9. `npm.cmd run build`: **passed** for all packages and all four applications.
10. Final source/production-runbook/private-reader review and `git diff --check`: confirmed target restriction and private-file checks. Git reports package.json LF-to-CRLF normalization as a warning; no whitespace errors.

## Authentication evidence

| Identity | Real Argon2id + fake-backed AuthService test | Live deployment |
| --- | --- | --- |
| qa-owner@example.invalid | Correct password accepted; wrong password denied | Not provisioned/verified |
| qa-admin@example.invalid | Correct password accepted; wrong password denied | Not provisioned/verified |
| qa-campaign-manager@example.invalid | Correct password accepted; wrong password denied | Not provisioned/verified |
| qa-billing@example.invalid | Correct password accepted; wrong password denied | Not provisioned/verified |
| qa-viewer@example.invalid | Correct password accepted; wrong password denied | Not provisioned/verified |
| qa-platform-owner@example.invalid | Existing bootstrap fixture accepted; wrong password denied | Not provisioned/verified |
| qa-operations-admin@example.invalid | Correct password accepted; wrong password denied | Not provisioned/verified |
| qa-billing-admin@example.invalid | Correct password accepted; wrong password denied | Not provisioned/verified |
| qa-support-admin@example.invalid | Correct password accepted; wrong password denied | Not provisioned/verified |
| qa-technical-admin@example.invalid | Correct password accepted; wrong password denied | Not provisioned/verified |
| qa-auditor@example.invalid | Correct password accepted; wrong password denied | Not provisioned/verified |

After disable, all ten seeder-owned fixture accounts are refused by AuthService with their previously valid passwords. The pre-existing test Platform Owner remains ACTIVE. Passwords, hashes, roles, audits and immutable claim are not replaced or deleted. The test organization is retained to preserve references. An audit-backed provenance requirement prevents adoption/cleanup of unrelated or activation-kit identities, even when their emails match. Existing guard/HTTP tests ran in the full suite; the new seeder scope tests additionally reject extra memberships in a foreign tenant. These fake-backed tests do not establish real PostgreSQL isolation/concurrency or deployed browser routing.

## Remaining limitations and deferred work

- No real PostgreSQL, protected Linux-file, concurrency or browser rehearsal ran. Earlier preflight found Docker unavailable and WSL access denied. No production resources were used as substitutes.
- No-activation setup applies to **newly seeded accounts only**. The immutable Platform Owner must already have been approved, bootstrapped and initialized with a known password. The existing first-owner bootstrap currently uses activation. It was not changed to bypass that contract, replace existing credentials or silently create the first owner. A fresh database therefore cannot obtain all eleven working no-link logins through this seeder alone.
- Cleanup disables the ten seeder-owned accounts only. The pre-existing test Platform Owner and `admin@truevoice.com` require separate explicit lifecycle authorization and remain untouched. Seeder reruns cannot reactivate disabled accounts.
- `admin@truevoice.com` was not inspected on the live host. The seeder can read its non-credential metadata only in the explicitly validated isolated target; an independent synthetic preservation test covers this behavior. User-reported ACTIVE status is not a live finding from this task.
- Remote development/staging targets and the named public deployment are intentionally unsupported by this implementation. Only explicitly configured disposable loopback test targets pass. Changing an environment variable is not evidence that a production database became development.
- The current production workflow requires successful main CI and explicit human authorization. No push, merge, dispatch, manual running-release modification or deployment was performed. No credentials belong in CI. Instructions describe a later authorized operator invocation after code delivery and environment verification; they are not a claim of a live execution.
- Missing product surfaces remain missing: notably platform Billing Admin has no implemented platform billing dashboard/action. A successful sign-in cannot create that functionality.
- Exact runtime-pin verification remains outstanding: the local Node/npm installation previously reported 24.20.0/11.19.0, satisfying engine ranges but differing from exact pins 24.19.0/11.17.0.

The [runbook](runbooks/test-account-seeder.md) contains exact private-config execution and manual interface instructions. Do not attempt these proposed identities on the live production host on the basis of this local test report.
