# Production test-account executable workflow — implementation results

Date: 2026-10-23. Branch: `feat/qa-role-test-kit`, base `0480655`.

Executable tooling is implemented and locally verified for code review. **Production execution and merge readiness remain blocked by the failed isolated-infrastructure preflight and outstanding independent approvals.** No production connection, account inspection/write, password initialization, actual live HTTP test, workflow dispatch, commit, push, merge or deployment occurred. Existing `admin@truevoice.com` and all existing work remain untouched. No live success is claimed.

## Files created or changed for this implementation

- `infrastructure/scripts/production-test-rollout.mjs`: executable private-file CLI; public inventory/invalid blank template; bootstrap delegation; approval/release/cluster/owner/admin checks; transactional ten-account provisioning, verification and disable.
- `infrastructure/scripts/production-test-rollout.d.mts`: explicit operator API/role declarations for NodeNext consumers; no TypeScript suppression.
- `infrastructure/scripts/production-test-rollout.spec.ts`: approval, conflict, real Argon2id, durable provenance/retry, rollback fixture, scope, initialization and cleanup tests.
- `infrastructure/scripts/production-test-http.mjs`: native private HTTP client; version preflight; CSRF/Secure/HttpOnly/SameSite assertions; no redirects; timeouts/expiry/pacing; one-time owner initialization; eleven-account sign-in/read-permission/denial/isolation/logout verification.
- `infrastructure/scripts/production-test-http.d.mts`: typed private-client/verifier interface.
- `infrastructure/scripts/production-test-http.spec.ts`: protocol and failure tests, including role drift, terms, wrong denial reason, insecure session/CSRF cookies, throttling, wrong HTTP release, redirects and protected owner completion.
- `apps/api/test/production-test-rollout.e2e-spec.ts`: isolated real PostgreSQL/native HTTP integration harness. Actual bootstrap/Prisma stores/Nest HTTP; owned database creation/migrations; final-audit failure rollback; concurrent first provisioning; idempotency/conflicts; synthetic terms acceptance via HTTP; all eleven protocol checks; disable/stale session/admin preservation. This suite is implemented but **did not execute beyond infrastructure preflight here**.
- `packages/auth/src/audit.ts`: three explicit production-rollout audit actions, preserving prior actions.
- `package.json`: root `rollout:test-accounts`, `test:production-rollout`, `test:production-rollout:e2e` entry points.
- `README.md`: executable-command and integration links.
- `docs/runbooks/production-test-account-execution.md`: exact stages, private configuration/approval contract, operator commands and retirement/rehearsal instructions.
- `docs/runbooks/README.md`: execution entry point.
- `docs/runbooks/production-test-account-rollout.md`: updates original planning baseline to point to the implemented tooling without authorizing execution.
- `docs/production-test-account-inventory.json`: identifies implemented provisioning entry point; executionAuthorized remains false.
- `docs/adr/0022-production-test-account-rollout.md`: security, durable audit-primary-key idempotency and separate HTTP/cleanup decisions.
- `docs/adr/README.md`: ADR link.
- `docs/production-test-rollout-implementation-results.md`: this report.

No existing seeder/bootstrap/CI workflow was edited, no dependency added, no Prisma schema/migration changed and no role/permission grant widened. The main checkout's unrelated work remains preserved.

## Executable interface

Start with `npm run rollout:test-accounts -- inventory` and `npm run rollout:test-accounts -- template`; neither accesses production or prints a credential. Private protected files plus action-specific independent approval are mandatory for the executable stages:

`bootstrap → initialize → provision → verify → custodian terms acceptance → http → separately approved disable`

See the execution runbook for exact arguments. Production additionally requires explicit confirmation, opt-in, correct production environment/origin, matching active `/var/www/TruevineVoice/current` REVISION/READY, expiring operation/release/inventory/credential references and actual PostgreSQL cluster fingerprint. Bootstrap is the original immutable mechanism, not a newly manufactured claim. Initialization uses its existing token and audited HTTP completion; the other ten get direct Argon2id passwords without email. `admin@truevoice.com` is projected read-only and must match the independently approved existing scope.

The committed batch audit primary key is the stable provision UUID, with exact tenant/user/role/source/release/bootstrap bindings. Fixed advisory locking, serializable preflight and existing database uniqueness fence concurrent calls; the final audit commits with all users. An unrelated existing user/tenant, changed password/status/role or extra membership refuses instead of repairing. Disable is separately approved, audit-fenced and preserves owners/history/passwords. Ambiguous failures return a fixed diagnostic and require reconciliation; no fresh operation IDs are generated automatically to evade conflict.

## Commands and outcomes, in order

Read-only source inspections are grouped chronologically; no production env/credential file was read.

1. `git status --short --branch`; targeted reads of original bootstrap, completed seeder/tests, auth caller views, bootstrap Linux/E2E harness and package scripts; `Get-Command docker,wsl,gh`: correct worktree/base and preserved work confirmed. Docker unavailable; WSL/gh executables exist. An exploratory `packages/database/src/client.ts` read failed; actual factory is `src/index.ts` and was read subsequently.
2. Source inspections of AppModule/AuthModule, existing real HTTP E2E setup, CSRF middleware, role-context views, generated schema contracts, NodeNext config and deployment markers: confirmed existing implementation contracts. Some large combined outputs were truncated and followed by targeted reads. Optional nonexistent source paths/search targets produced no contents; actual `deploy.mjs`, auth exception filter and database index were used.
3. Implemented runtime tools/tests and root commands. `npm.cmd run build:packages`: passed.
4. `npm.cmd run test:production-rollout`: initially **27 passed**, then **28**, **29**, and final **30** cases as initialization/cookie/version checks were added. Final full npm test includes all thirty.
5. First `npm.cmd run test:production-rollout:e2e`: failed before collection due Windows/Vitest dynamic-import resolution. Fixed with static NodeNext imports and explicit `.d.mts` interfaces. No tests were skipped/weakened to fix it.
6. Initial `npm.cmd run lint`: passed. Initial `npm.cmd run typecheck`: failed on two implicit-any callback types from those dynamic imports. Explicit module declarations/static imports fixed the cause; subsequent complete typecheck passed. No strictness change or suppression was introduced.
7. Repeated `npm.cmd run test:production-rollout:e2e` after the import fix: **failed loudly at infrastructure preflight**: no explicitly disposable ROLLOUT_TEST_ADMIN_URL/opt-in supplied. One suite failed; Vitest marked its one case unrun/skipped because beforeAll threw. There is no it.skip/conditional skip in the new suite. No database connection, create/drop, migration or HTTP server was started. The final attempt has the same clear prerequisite failure.
8. Added real rollback/concurrent-first-create assertions to that executable E2E harness. It recognizes the already-approved strict CI disposable fixture pattern as well as an explicitly opted-in loopback `/postgres` admin URL. No CI workflow was modified or dispatched.
9. `npm.cmd run typecheck`: passed across configured workspaces, including the new typed API integration test. `npm.cmd test`: passed; intermediate infrastructure count 296 then 298 as new tests were added.
10. `npm.cmd run build`: passed for all packages and API, worker, web and admin. `npm.cmd run rollout:test-accounts -- inventory`: passed with eleven fictional addresses and public inventory digest only.
11. Final ordered quality-gate run: `npm.cmd run lint`, `npm.cmd run typecheck`, `npm.cmd test`, `npm.cmd run build`: **all passed**. Full test run then had 298 infrastructure cases passed and three existing skips. A final CSRF-cookie assertion added afterward changes only the standalone JavaScript HTTP tool/test; final lint and full tests were rerun as below. Application/package TypeScript and build inputs remained unchanged.
12. `git diff --check`, `git diff --name-only -- .github/workflows infrastructure/scripts/bootstrap-platform-owner.mjs infrastructure/scripts/test-account-seeder.mjs`, status and Docker availability reads: no whitespace errors; no tracked workflow/bootstrap diff; no seeder edits made by this task; Docker still absent. Existing package.json LF-to-CRLF normalization warning remains.
13. Existing CI/database environment and private HTTP source review: confirmed job-level test NODE_ENV and loopback disposable fixture available to the existing E2E command, without adding Actions use. No skipped-test/ts-ignore patterns found in the new tests (rg returned its normal no-match exit status 1).
14. `npm.cmd run rollout:test-accounts -- template`: passed; all credential values null and production authorization false. Deliberate unauthorized `verify` invocation with nonexistent private paths: exit 1, fixed refusal diagnostic, no credential/ORM output or database access.
15. After the final CSRF-cookie guard, `npm.cmd run lint`: **passed**; `npm.cmd test`: **passed**, including **299 infrastructure tests plus three pre-existing Windows skips** and all thirty new focused cases. Workspace counts: admin 43, API 617, web 141, worker 5, auth 111, database 5, domain 58, messaging 21, queue 8, shared 19, telephony 18. Existing POSIX-only db-verify/backup runtime commands explicitly skipped on Windows, as before; their static tests ran. Expected failure-path audit/Redis diagnostics appeared, with no secret output.
16. Final focused-command/document-link/inventory/whitespace checks and Git status inspected before handoff. No commit, push or PR creation performed.

## Review findings and limits

- The executable database/HTTP integration harness is **not green** in this environment. Real PostgreSQL rollback/concurrency, real HTTP sign-in/initialization/authorization/cleanup, protected Linux file handoff and isolated HTTPS evidence remain unverified. Fake-backed unit fixtures and mock transports cannot establish those contracts. A successful focused/local suite is not live evidence.
- The database/HTTP harness uses actual loopback HTTP only under explicit disposable test-mode rules. Its Redis lifecycle and rate limiter are fixture substitutions; unchanged rate-limit/Redis tests cover those contracts separately. Production tooling keeps real TLS, pacing, limits, CSRF and current terms, and stops on 429/lockout/terms/version failures.
- Custodians must accept terms normally before organization HTTP verification. No automatic terms insertion/consent or email sending was implemented. The HTTP command checks representative implemented read permissions plus exact organization permission arrays; privileged mutations and browser UI are intentionally reported as not exercised.
- Platform Billing Admin can authenticate but has no implemented authorized platform billing dashboard/endpoint. Other unconsumed permission names remain unavailable; no new feature or permission was invented to turn those into a pass.
- Cleanup disables ten provenance-bound users only, not the bootstrap owner or `admin@truevoice.com`. Retiring the sole owner requires an independent approved owner-lifecycle/recovery-custodian decision and must preserve the immutable claim. No account reactivation, credential repair, row deletion or database rollback path was added.
- Current runtime remains the previously observed Node 24.20.0/npm 11.19.0, satisfying engine ranges but differing from exact 24.19.0/11.17.0 pins. Existing CI/deployment pin gates must still pass.
- Existing bootstrap documentation/manifest historical disagreement is not live migration evidence. Check actual deployed ledger and approvals before code/schema deployment. No SQL/approval manifest was changed in this implementation.

## Exact remaining steps

1. Provide a verified disposable local PostgreSQL instance or authorize committing/pushing this reviewed branch so the existing isolated CI E2E can run once. Run `npm run test:production-rollout:e2e` and the Linux bootstrap/private-file tests; complete trusted isolated HTTPS rehearsal and resolve every failure. Do not substitute production.
2. Independently review this implementation/diff and rehearsal evidence, then explicitly authorize commit/push/PR/merge as applicable. Suggested PR title: **Add gated production QA account provisioning and private HTTP verification**. Describe the immutable-bootstrap delegation, operation-fenced ten-account batch, preserved admin/local seeder/CI controls and failed local infrastructure preflight honestly. Do not mark integration checks passed before actual evidence exists.
3. Authorize the exact reviewed release/schema set through the existing successful-current-main CI and protected human-dispatch deployment workflow. Deployment itself does not authorize seeding; no credentials belong in Actions.
4. Separately authorize read-only live inventory and prepare exact target/cluster/admin/claim/no-conflict findings, the private credential configuration and independent bootstrap/initialize/provision/HTTP approvals. Populate the invalid blank template privately; JSON flags are not human authorization.
5. An authorized Linux operator executes the documented stages from the matching active READY release. Record actual safe per-account HTTP evidence; separately approve any privileged mutation/browser checks and retirement. Keep production security configuration unchanged. No such stage has run in this task.
