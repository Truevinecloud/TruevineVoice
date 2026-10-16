# RBAC-001 final verification ? 2026-10-16

Branch: `feat/rbac-001-organization-owner`. `DEPLOYMENT_READY=false`.

The existing working tree was continued, reviewed and preserved. The HTTP 204
proxy fix and its regression tests remain. Verification output now uses stdout/
stderr without a lint exception. Missing frontend credentials fail explicitly.
The security harness no longer offers to delete rate-limit keys.

## Results

| Gate | Result |
| --- | --- |
| `npm run lint` | Passed, no lint rules weakened |
| `npm run typecheck` | Passed across all workspaces |
| `npm run prisma:validate` | Passed |
| `npm test` | 451 passed, 3 existing Windows skips |
| API unit tests (included above) | 122 passed |
| Customer frontend tests (included above) | 61 passed, including 204 regression tests |
| Admin frontend tests (included above) | 3 passed |
| `npm run test:e2e` | API 30, database 33, worker 5 passed; zero skipped |
| `npm run build` | All packages and API, worker, web and admin production builds passed |
| `npm run verify:journey` | 43/43 passed through the real frontend proxy |
| `npm run verify:frontend` | 41/41 HTTP/HTML checks passed with authenticated test account |
| `npm run verify:boundaries` | Final expanded run 29/29 passed, including both tenant directions |
| Browser automation | Unavailable: empty browser inventory; opening iab returned Browser is not available: iab |

The 3 skipped deployment cases are pre-existing POSIX-only tests in
`infrastructure/scripts/deploy.spec.ts`. The db-verify runtime and backup runtime
suites also reported SKIP on Windows. Their static tests passed. No skipped test
is counted as passed; no test was disabled or weakened during this task.

## Complete activation journey

Provisioned a disposable first Owner; verified sign-in fails before activation;
consumed the activation token; rejected its reuse; signed in and checked HttpOnly
cookie/session identity; accepted test terms; rendered the dashboard; updated
organization settings; provisioned an independent teammate account; invited it;
accepted its invitation; changed its role; created/revoked a second invitation;
transferred ownership; verified old/new roles; removed the former Owner; verified
immediate loss of organization access; requested/completed a separate password
reset; rejected reset-token reuse; replayed the stale session and received 401;
signed in again; signed out; replayed the prior session and received 401.

All mutations used `http://localhost:3000/api`, exercising Next.js to NestJS to
PostgreSQL/Redis. The dashboard used the real frontend route. Email tokens came
from development capture files, never real email. Seven distinct successful
sensitive action names were checked in organization-scoped audit records.

This verifies real HTTP interactions and server-rendered HTML. It does not verify
hydration, clicking controls, client validation or browser cookie enforcement.
No browser journey is claimed.

## Security evidence and limits

Two independent organizations were provisioned and activated. Cross-tenant reads,
member lists and invitation creation returned 403. The reverse B-to-A profile
read also returned 403 and was audited against A. Nonexistent forged IDs returned
the same denial; a body organization ID could not redirect a path-scoped write,
and the other organization remained unchanged. Missing and mismatched CSRF
headers returned 403 without changing the profile. Activation/reset token reuse
and captured session replay were rejected in the journey. Sensitive successful
actions, identity actions and cross-tenant denials were found in audit tables.
A DELETE of the run-owned audit rows was rejected by the append-only trigger.

Platform API probe returned 404 because the platform route does not exist. The
frontend proxy refused admin paths with 404; permission separation unit tests
passed. This is not live authorization testing of a functioning platform admin
application. RBAC-002 was not implemented.

## Failures, warnings and release blockers

- Sandbox attempts to use Docker/Get-NetTCPConnection and spawn Vitest, the
  provisioning child process and Next.js TypeScript workers failed with access
  denied/EPERM. Required commands were rerun with elevated execution and passed.
- A repeat security run exhausted the genuine sign-in limiter and aborted before
  obtaining membership data. It is a failed attempt, not a passing test. Counters
  were inspected read-only and were not cleared.
- Two attempted file-edit helpers failed before editing (Python unavailable; a
  JavaScript quoting error); corrected Node-based edits succeeded.
- Git emits LF-to-CRLF normalization warnings; `git diff --check` passed.
- No actual terms document or production email delivery is configured. Only test
  terms acceptance and development message capture were exercised.
- Migration production approval/staging compatibility, citext privilege setup,
  audit retention/erasure policy and platform-scoped denial audit remain unresolved.
- Inspection found deactivation recovery is not implemented as the ADR claims:
  completePasswordReset does not change SUSPENDED back to ACTIVE. No recovery
  success is claimed; this remains a release defect.

## Commands executed and outcomes

The following records the significant command sequence; file reads/searches were
read-only. Raw logs are local, ignored files in `.deployment-validation/`.

1. `Get-Content README.md; Get-Content AGENTS.md; git status --short; git branch --show-current` ? inspected existing branch and working tree.
2. Read package scripts, verification harnesses, existing code/tests, web AGENTS.md, ADR 0009, migration review and release blockers; `git diff --stat`, targeted `git diff`, `rg` and `Get-ChildItem` ? reviewed scope.
3. `npm run lint` ? initial pass with inherited script exception; exception subsequently removed.
4. Read computer-use SKILL.md; browser inventory and iab creation ? browser unavailable.
5. `npm run infra:ps` and `Get-NetTCPConnection ...` ? sandbox denied; elevated `npm run infra:ps` confirmed local healthy PostgreSQL 18 and Redis.
6. Node fetch probes for local API health and web sign-in ? both 200.
7. Attempted Python edit ? Python unavailable; corrected Node edit ? succeeded.
8. `npm run lint`, `npm run typecheck`, `npm run prisma:validate`, `npm test` ? lint/typecheck/schema passed; sandbox test spawn failed.
9. Elevated `npm test` ? 451 passed, 3 skipped plus two Linux runtime suite skips.
10. Elevated `npm run test:e2e` ? 68 passed.
11. `npm run verify:journey` ? sandbox spawn failed; elevated retry ? 34/34 passed.
12. Elevated `npm run verify:boundaries` ? 28/28 passed.
13. `npm run build` ? sandbox worker spawn failed; elevated retry ? all production builds passed.
14. Set disposable OWNER_EMAIL/OWNER_PASSWORD; `npm run verify:frontend` ? 41/41 passed.
15. Elevated expanded `npm run verify:journey` ? 43/43 passed, including member removal and action-specific audit assertions.
16. `npm run lint; git diff --check` ? passed.
17. Elevated expanded `npm run verify:boundaries` ? aborted after sign-in rate limiting; no partial success claimed.
18. Read-only `docker exec truevine-redis redis-cli --scan --pattern tv:rl:*` and MGET of development sign-in buckets ? current counter 11; retained limiter.
19. Corrected a failed Node edit; formatted verification scripts with the installed Prettier API; documented verification commands and limitations.
20. Elevated `npm test` after extending deactivation CSRF guard coverage ? 451 passed, same existing skips.
21. `npm run lint` and `git diff --check` after edits ? passed.
22. Waited for the real limiter window without clearing counters; elevated `npm run verify:boundaries` ? 29/29 passed.
23. Set credentials for the disposable current Owner; `npm run verify:frontend` - 41/41 passed.
24. A diagnostic Node log counter initially read PowerShell UTF-16 logs as UTF-8 and printed zero; PowerShell Select-String confirmed 43 journey, 29 boundary and 41 frontend PASS lines.
25. Report generation/git staging initially hit sandbox EPERM/index.lock permissions; elevated retry succeeded.
26. Final `git diff --check`, staged-file review and secret-path checks ? passed; local commit 638d7c7 created as requested. A documentation-only follow-up corrects the repeated frontend count to 41; no history rewrite.

## Deferred work and readiness

No production system was changed. No migrations were run against any database.
No push, merge or deployment occurred. Existing applied migrations were not
edited. Local development fixtures and immutable audit records were retained.

The fixes can be reviewed in a draft PR with these limitations visible. RBAC-001
is not release-ready and final browser/security sign-off remains incomplete.
RBAC-002, production setup, legal terms, erasure policy and deactivation recovery
were deliberately not implemented in this final-verification task.

## Files created or changed

- `apps/api/test/route-guards.spec.ts`
- `docs/migrations-rbac-001-review.md`
- `docs/rbac-001-final-verification.md`
- `docs/release-blockers.md`
- `infrastructure/scripts/verify-activation-journey.mjs`
- `infrastructure/scripts/verify-frontend.mjs`
- `infrastructure/scripts/verify-security-boundaries.mjs`
- `packages/database/prisma/migrations/20261016153000_organization_suspension/migration.sql`
- `README.md`
- `apps/api/src/auth/auth.controller.ts`
- `apps/api/src/auth/auth.service.ts`
- `apps/api/src/auth/auth.store.ts`
- `apps/api/src/auth/organization.guard.ts`
- `apps/api/src/auth/prisma-stores.ts`
- `apps/api/src/organizations/organizations.controller.ts`
- `apps/api/test/auth.service.spec.ts`
- `apps/api/test/authorization.e2e-spec.ts`
- `apps/api/test/authorization.guard.spec.ts`
- `apps/api/test/fakes/auth.fakes.ts`
- `apps/web/src/app/api/[...path]/route.ts`
- `apps/web/src/lib/proxy.spec.ts`
- `docs/adr/0009-authorization-and-audit.md`
- `package.json`
- `packages/auth/src/audit.ts`
- `packages/database/prisma/schema.prisma`
- `packages/messaging/src/email.spec.ts`
- `packages/messaging/src/email.ts`
