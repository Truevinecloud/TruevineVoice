# Truevine Voice RBAC-001–015 implementation and verification

Audit date: 2026-11-19. Workspace: `feat/rbac-013-sensitive-action-audit` with staged and unstaged work, including concurrent changes to support access and enterprise governance.

## RBAC-015 Phase 1 final PATCH validation — 2026-11-20

PATCH now validates the full permission array at the controller boundary. An unknown, malformed, platform, or duplicate entry returns HTTP 400 with the existing `invalid_request` envelope before the mutation service runs. A malformed field such as null or a scalar also returns 400. Omission passes through as unchanged, and an explicit empty array can clear permissions through the existing locked authorization path. Duplicates are rejected because a role's stored permissions are unique. Create-role input behavior is outside this change.

Session, organization, terms and CSRF guards remain on the PATCH route. Invalid input that reaches the controller is distinct from a business authorization refusal. Tests confirm rejected input never calls the mutation service and produces neither a business write nor a success or denial audit. A recognized permission outside the actor's delegation scope reaches the service, retains its 403 and records exactly one denial event. Additional tests verify omission and explicit clearing, including the audited delta.

| Command | Result |
|---|---|
| `npm.cmd run test --workspace @truevine/api -- custom-role security-transaction.spec.ts authorization.guard.spec.ts route-guards.spec.ts --maxWorkers=1` | Exit 1. **391 passed across four suites**, including nine new PATCH regressions. The route-contract suite executed zero tests because `apps/api/src/campaigns/campaigns.service.ts:24` imports unresolved `../../tokens.js`. |
| `npm.cmd run typecheck --workspace @truevine/api` | Rerun after interruption exited 2. Concurrent audio storage imports unresolved `@nestjs.common`. The campaign service imports unresolved `../../tokens.js` and its spec supplies four constructor arguments where five are expected. No diagnostic was reported in either changed file. |
| `npm.cmd exec -- eslint apps/api/src/custom-roles/custom-roles.controller.ts apps/api/src/custom-roles/custom-role.service.spec.ts` | Rerun after interruption exited 0. |

Files changed:

- `apps/api/src/custom-roles/custom-roles.controller.ts`
- `apps/api/src/custom-roles/custom-role.service.spec.ts`
- `docs/rbac-001-015-master-implementation-verification-report.md`

Ready for focused independent read-only re-review. The current mixed checkout still needs a clean route-contract run. Live PostgreSQL verification remains pending separate authorization and an isolated source, schema, and migration snapshot. No build, database operation, Phase 2 integration, or change to W3-03, W3-04 or the migration fingerprint guard occurred.

## RBAC-015 Phase 1 review remediation — 2026-11-20

**Status: remediation implemented and submitted for independent read-only re-review.** The existing review verdict is superseded only by a new reviewer decision. Live PostgreSQL verification remains pending.

The custom-role mutation path explicitly requests `ReadCommitted`. The Prisma adapter forwards that option, typed as Prisma `TransactionIsolationLevel`, to the outer transaction. Existing callers that omit the option retain their current behavior. The organization row lock remains first, followed by the actor row lock and fresh tenant, actor, membership, delegation and target reads. This protocol assumes concurrent membership, role, permission and assignment writers acquire the same organization row lock before modifying authority. The actor lock protects the active-user check from concurrent user status changes that take that lock. Under READ COMMITTED, a later authorization statement can observe a transaction that committed while the request waited for the organization lock. Service and adapter fakes verify the option and post-lock decision order. They do not establish actual PostgreSQL isolation or rollback.

After the mutation transaction rejects, covered domain refusals use the established identity audit writer. The record contains the actor, server-defined operation and refusal code, and a digest of the attempted tenant. It does not fetch foreign target state or retain target identifiers. Coverage includes stale actor authority, delegation, protected roles, missing tenant-scoped targets or members, and role or assignment conflicts. The service only audits refusals it handles, so a request refused by the ingress guard never reaches this audit path. A failed denial insert emits a fixed warning and the original refusal is rethrown. Mandatory success audits remain inside the mutation transaction.

PATCH preserves an omitted description and clears it on explicit null. Empty and equivalent updates return the locked view without writes or success audits. Permission order alone is equivalent. Actual updates store the locked before-state and persisted after-state. The change object contains only changed fields, with a digest for description changes.

### Validation

| Command | Outcome |
|---|---|
| `npm.cmd run test --workspace @truevine/api -- custom-role security-transaction.spec.ts authorization.guard.spec.ts route-guards.spec.ts --maxWorkers=1` | Exit 1. Four suites passed with 382 tests. The route-contract suite failed before running tests because concurrent `apps/api/src/campaigns/campaigns.service.ts:24` imports unresolved `../../tokens.js`. The passing suites included ReadCommitted adapter forwarding, revocation-first fake behavior, denial persistence and safe failure, and the PATCH cases. |
| `npm.cmd run typecheck --workspace @truevine/api` | Exit 2. Diagnostics were in concurrent campaign and audio files, including unresolved imports, missing exports, constructor arity, and audio storage schema/config mismatches. No diagnostics in remediation files. |
| `npm.cmd exec -- eslint apps/api/src/auth/prisma-stores.ts apps/api/src/auth/security-transaction.ts apps/api/src/auth/security-transaction.spec.ts apps/api/src/custom-roles/custom-roles.controller.ts apps/api/src/custom-roles/custom-role.service.ts apps/api/src/custom-roles/custom-role.service.spec.ts apps/api/src/custom-roles/custom-role.fakes.ts` | Exit 0. |
| Build and PostgreSQL tests | Unexecuted per scope. |

Files changed:

- `apps/api/src/auth/prisma-stores.ts`
- `apps/api/src/auth/security-transaction.ts`
- `apps/api/src/auth/security-transaction.spec.ts`
- `apps/api/src/custom-roles/custom-roles.controller.ts`
- `apps/api/src/custom-roles/custom-role.service.ts`
- `apps/api/src/custom-roles/custom-role.service.spec.ts`
- `apps/api/src/custom-roles/custom-role.fakes.ts`
- `docs/rbac-001-015-master-implementation-verification-report.md`

### Remaining verification dependency

A separately authorized disposable run needs an isolated source snapshot containing the reviewed Phase 1 code, schema and generated client matched to the approved 23-file migration snapshot. Keep the working tree's W3-04 migration and existing fingerprint guard intact. Verify the exact disposable endpoint and complete migration ledger before writing fixtures. Exercise both real lock orderings, confirm the isolation level, inject mandatory audit-insert failure for each operation and verify rollback from another connection. Verify post-rollback denial persistence and PATCH no-op behavior. No database, credential, environment file, infrastructure setting, or W3-03/W3-04 file changed during this remediation. Central guard and session integration remain out of scope.

## RBAC-015 Phase 1 custom-role mutation hardening — 2026-11-20

Create, edit, delete, assign and unassign now take the organization lock before loading current tenant, actor membership and relevant target state. The actor row is locked and the actor must still be active. Delegation is checked with the fresh built-in role. Internal custom grant hints can contribute only when the tenant-scoped grant still exists. The HTTP controller continues to supply an empty hint list, so this phase introduces no effective-permission integration into the guard or session response.

Role, permission, assignment and mandatory success-audit writes now use stores bound to the same Prisma transaction. A failed audit rejects the transaction. Audit snapshots are taken from the locked pre-mutation state and the persisted result. Role descriptions are represented by digests. System-role protection and strict downward assignment checks remain in place. Role creation uses its existing generated UUID default rather than supplying the display name as the UUID. The Prisma custom-role adapter moved to the authentication persistence module so both the standalone read provider and transaction-scoped adapter are wired there and the feature receives the exported provider.

The unit tests simulate a downgrade, membership removal, account suspension, revocation of a custom delegation hint, newly privileged target role, target membership moving across tenants, and an assignment appearing before deletion. All five mutation paths are tested for staged writes discarded on audit failure and exactly one success audit on retry. Existing cross-tenant, delegation and system-role assertions remain in place. The updated audit fixture also verifies that the recorded before state comes from the post-lock read.

| Command or check | Outcome |
|---|---|
| `npm.cmd run test --workspace @truevine/api -- custom-role authorization.guard.spec.ts route-guards.spec.ts --maxWorkers=1` | Initial 411 passed and one fixture failed. The Viewer test still stored an Owner membership. Corrected the fixture to reflect a current Viewer without changing the denial assertion. Final runs passed all 412 tests across four files. |
| `npm.cmd run typecheck --workspace @truevine/api` | Exit 0, no emit. The workspace-specific entry point avoided the root typecheck's package rebuild. |
| `npm.cmd run lint` | Exit 1. ESLint reported 14 console errors in the unrelated script `scripts/check-orgs-for-cross-tenant.mjs` and the existing admin billing hook warning. No Phase 1 files had lint findings. |
| Production build | Skipped on the user's instruction to resume without rebuilding. |

Files changed in Phase 1:

- `apps/api/src/auth/auth.module.ts`
- `apps/api/src/auth/prisma-stores.ts`
- `apps/api/src/auth/security-transaction.ts`
- `apps/api/src/auth/prisma-custom-role.store.ts` (moved from `apps/api/src/custom-roles/prisma-custom-role.store.ts`)
- `apps/api/src/custom-roles/custom-roles.module.ts`
- `apps/api/src/custom-roles/custom-role.service.ts`
- `apps/api/src/custom-roles/custom-role.service.spec.ts`
- `apps/api/src/custom-roles/custom-role.fakes.ts`
- `apps/api/test/fakes/auth.fakes.ts`
- `docs/rbac-001-015-master-implementation-verification-report.md`

Phase 1 is ready for independent code review. The fake-backed tests verify the service and transaction contract. PostgreSQL lock ordering and rollback need a separately authorized disposable verification run. No database or fixture was accessed or changed. RBAC-014 remains blocked and custom-role guard/session integration, SSO and SCIM remain outside this phase. W3-03 files and shared infrastructure were preserved.

## Final RBAC-014 authorization disposition — 2026-11-20

**BLOCKED:** authenticated RBAC-014 browser E2E and persisted support-session audits from that journey. The 28 synthetic Platform Owner assignments are test records and supply no authorized operator. The documented first-owner bootstrap rejects this database name and the presence of any prior Platform Owner assignment, including revoked ones. The decision is final for the current authorization. No bootstrap, database rename, role removal, replacement grant mechanism, privileged identity creation or impersonation is in scope.

A future operator-assisted run requires an identified, authorized Platform Owner with a private session on the exact QA API for `truevine_rbac_qa_20261120_031000_4f92` at `127.0.0.1:55432`. After separate explicit authorization, one dedicated QA-only identity must be provisioned through an approved one-account workflow. The operator uses the application's authenticated, CSRF-protected `POST /platform/admin/roles` grant requiring `platform:admin:manage` and grants `SUPPORT_ADMIN` to that identity only. Credentials and session material stay with the operator. The batch seeder exceeds the one-account scope. The existing verified synthetic tenant pairs can be reused. The earlier Chrome test used a synthetic API, so its evidence is limited to the browser, built UI and proxy.

| RBAC | Implementation | Unit/component or fake-backed HTTP | Live PostgreSQL or authenticated browser | Remaining gap |
|---|---|---|---|---|
| 001 Owner | Implemented | Verified | Organization and tenant suites passed | Full authenticated ownership journey |
| 002 Admin | Implemented | Verified | Organization and tenant suites passed | Authenticated delegation journey |
| 003 Campaign Manager | Implemented for draft workflows | Verified | Campaign and tenant suites passed | Authenticated draft journey |
| 004 Billing | Implemented for existing billing workflows | Verified | Billing and tenant suites passed | Authenticated billing journey |
| 005 Viewer | Implemented | Verified | Full reporting journey pending | Authenticated reports |
| 006 Platform Owner | Implemented | Verified | Full browser journey pending | Authorized platform administration sign-in and workflow |
| 007 Operations Admin | Implemented | Verified | Audit suite exercised emergency-stop persistence | Authenticated emergency-stop journey |
| 008 Billing Admin | Implemented | Verified | Platform billing suite passed | Authenticated reconciliation journey |
| 009 Support Admin | Implemented | Verified | Authenticated browser coverage blocked | Authorized Support Admin access |
| 010 Technical Admin | Implemented | Verified | Full browser journey pending | Authenticated troubleshooting |
| 011 Auditor | Implemented | Verified | Full browser journey pending | Authenticated read-only workflow |
| 012 Tenant isolation | Implemented for covered routes and operations | Verified | **196 live tests passed**, including missing-tenant denial audit persistence | Custom-role effective permissions remain outside this evidence |
| 013 Sensitive audit | Implemented for covered actions | Verified | **30 live tests passed**, including rollback and immutability | Broader authenticated audit journeys |
| 014 Controlled support access | Implemented | Unit/HTTP/component verified. Synthetic-API browser scenario passed | **BLOCKED** for authenticated browser and its persisted audit evidence | Authorized operator-assisted grant and eligible Support Admin |
| 015 Enterprise governance | Custom-role management implemented. Effective permissions, SSO and SCIM incomplete | Custom-role service, route and form verified | Custom-role migration ledger verified. Management journey pending | Effective-permission security approval, live custom-role verification, SSO and SCIM |

`npm.cmd run test --workspace @truevine/api -- authorization.guard.spec.ts route-guards.spec.ts disposable-database.spec.ts support-access.service.spec.ts support-context-denial.http.spec.ts auditor.http.spec.ts custom-role --maxWorkers=1` exited 0 with **443 tests passed across eight files**. The deliberate failing-audit fake emitted the expected denial-audit warning. This run used unit and fake-backed HTTP tests and opened no PostgreSQL connection. Previous build, lint, typecheck and frontend results carry forward.

The master report was the only changed file. The previously verified 23 migration ledger entries and checksums, synthetic tenants, existing accounts, infrastructure and W3-03 work were preserved.

## RBAC-014 Support Admin provisioning preflight — 2026-11-20

The operator authorized one new QA-only Support Admin, conditional on using the supported provisioning workflow and an existing authorized grant actor. The launcher verified `truevine_rbac_qa_20261120_031000_4f92` and all 23 migration ledger entries and checksums at `127.0.0.1:55432`. Two read-only aggregate Prisma queries verified the connected database, internal PostgreSQL port and read-only transaction state before inspecting role and bootstrap counts.

- The QA database has 28 active, unlocked and unrevoked Platform Owner role rows. All 28 have the synthetic fixture email domain. The documented local QA Platform Owner was ineligible on this database, the documented seeder Platform Owner identity had no current assignment, and the bootstrap table contained zero claims. No private sign-in or operator authorization was established for any fixture identity.
- Both existing Support Admin assignments remain revoked. The supported platform role endpoint, `POST /platform/admin/roles`, requires an authenticated actor with `platform:admin:manage` and a valid CSRF token. The documented batch seeder requires an existing initialized Platform Owner and creates additional users and a tenant, so it is outside the approved one-account scope.
- Provisioning stopped before account creation or credential generation. **Zero accounts were created and zero grants were issued.** No real API browser test or browser-specific audit verification ran. The existing synthetic tenant pairs remain available. The earlier synthetic-API browser run remains separate evidence.

To continue, an authorized operator must identify an eligible existing Platform Owner on this exact QA database and make their authenticated session available privately, or separately authorize a supported grant mechanism for this database. If the supported route requires initializing the first Platform Owner, that is a separate operation requiring explicit approval. Account provisioning must still create only the one approved Support Admin and reuse the existing synthetic tenants.

Commands executed were `node infrastructure/scripts/run-tenant-isolation-qa.mjs verify 904b7c6a30cba331cf88977d6042f04b65005fe25cbf571552e5ff7b2f3c9762`, two read-only Node/Prisma aggregate inventories, and repository, runbook and controller reads. The ledger and both inventories exited 0. Only this report changed. Earlier lint, typecheck, build and test results carry forward. All databases, credentials, accounts, W3-03 files and infrastructure were preserved.

## RBAC-014 fixture and lint follow-up — 2026-11-20

The approved launcher reverified the exact QA database and all 23 migration ledger entries and checksums. Two aggregate inventory queries connected through `127.0.0.1:55432` to `truevine_rbac_qa_20261120_031000_4f92`, required the expected database identity and PostgreSQL server port, and ran in read-only transactions. They returned counts and role status only. Passwords, hashes, tokens, cookies, session identifiers, and connection credentials were neither selected nor exposed.

| Requirement | Evidence |
|---|---|
| Authorized Support Admin | Two `SUPPORT_ADMIN` assignments were present. Both were revoked, with active, unlocked user records. There were zero active, unlocked operators with a current assignment. The specific Support Admin documented in the local QA runbook was absent on this isolated instance. |
| Synthetic tenants | 144 organizations total. Two unsuspended A/B pairs matched the tenant-isolation fixture names, UUID slugs, common creation timestamps and synthetic owner marker. A verified pair can be reused without creating or altering tenants. |
| Support session history | Zero rows at inventory time. No authenticated browser requests were made. |
| Workspace lint | `npm.cmd run lint` exited 0 with the existing `react-hooks/exhaustive-deps` warning in `apps/admin/src/app/billing/page.tsx:127`. The five previously failing scratch paths were absent from the checked working tree and the earlier errors did not reproduce. No scratch scripts or lint configuration were edited. |

**Approval needed:** Authorize provisioning one dedicated QA-only `SUPPORT_ADMIN` on this exact isolated database and a private credential handoff, or arrange for an authorized operator to make an eligible account available there. The two currently revoked assignments and all existing credentials are outside this request. If provisioning requires a Platform Owner or other grant authority, supply a separately authorized actor for this database before making the grant. The existing matched tenant pairs cover the fixture requirement.

Once the account is available, pin the real loopback API to this database, use a separate browser session, and reuse one verified A/B fixture pair. Exercise authorization before a capability is issued, support access creation and listing, matched diagnostics and foreign-tenant denial, HttpOnly cookie visibility, natural expiry, and explicit revocation in a second session. Verify the database audit trail for creation, matched diagnostics, denied access, observed expiry and revocation against the real actor and target. The previous synthetic-API browser result remains separate evidence.

Commands executed were the repository/runbook/schema reads and scratch-file status checks, `npm.cmd run lint`, `node infrastructure/scripts/run-tenant-isolation-qa.mjs verify 904b7c6a30cba331cf88977d6042f04b65005fe25cbf571552e5ff7b2f3c9762`, and the two read-only Node/Prisma aggregate queries described above. The ledger and both inventories exited 0. This report was the only changed file. The earlier test, typecheck and build results carry forward. The RBAC-001–015 table below remains current apart from the resolved workspace lint blocker and the more specific RBAC-014 account blocker recorded here.

## Final security follow-up — 2026-11-20

The accepted isolated-QA baseline was **271 passing tests** (196 live RBAC-012, 30 live RBAC-013, and 45 focused regressions). The approved database and 23-migration ledger remain the basis of the live evidence. The launcher reverified the database name and all 23 migration checksums and completion states before each live rerun.

### Denial audit investigation and fix

The three warnings came from two authenticated missing-tenant GETs in the tenant-isolation suite (an outsider and a member of another tenant) and an authenticated missing-tenant GET in the authorization suite. The anonymous probe stops at the session guard. For each authenticated probe the old guard attempted to insert a tenant audit row with the nonexistent organization as its foreign key. PostgreSQL could not persist that row and the old path had no identity-trail fallback. These fixtures represent intentional probes. A real foreign tenant has a valid organization row and its tenant audit can be persisted. Both missing and foreign organizations continued to return the same 403 response, so the defect affected audit coverage.

The guard now writes authenticated denials for nonexistent organizations to the existing identity audit trail. It stores the actor, action, outcome, permission, reason and a digest of the attempted organization identifier. Existing targets retain tenant-scoped events. Unexpected lookup or audit failures still produce the operational warning and preserve the refusal. Tests inspect the PostgreSQL audit rows for all three probes and retain the response equivalence assertions. The live reruns passed **196 RBAC-012 tests across 11 files** and **30 RBAC-013 tests in one file**. The three warnings were absent from the live rerun. The focused authorization and route-guard suites passed 352 tests and still emitted the warning under the deliberate failing-audit fake.

### Authenticated RBAC-014 readiness

Real browser execution is pending an authorized QA-only Support Admin sign-in and two synthetic organizations on the isolated database. Use the documented private credential handoff and the real loopback API with the exact QA URL and `EXPECTED_DATABASE_NAME=truevine_rbac_qa_20261120_031000_4f92`. Start the built admin app on the same host through its API proxy and use a separate browser session. Validate denial without a capability or with the wrong role, support-session creation with a reason, history visibility, matched and foreign-organization diagnostics, HttpOnly cookie visibility at the matching path, expiry and revocation. Check the persisted creation, diagnostics, expiry and revocation audit records for actor, scope, reason, time and outcome. No browser run, accounts, credential changes or browser fixture provisioning occurred in this pass. The earlier synthetic-API browser result remains separate.

### Control status

| ID | Verified evidence | Still open |
|---|---|---|
| 001 Owner | Customer navigation, authorization and live organization suites | Full authenticated browser ownership journey |
| 002 Admin | Delegation and guard contracts, role navigation and live organization suites | Full authenticated browser delegation journey |
| 003 Campaign Manager | HTTP permissions, live tenant/campaign suites and navigation | Authenticated draft workflow |
| 004 Billing | HTTP, live billing and tenant suites, and role navigation | Authenticated billing journey |
| 005 Viewer | Read-only permission contracts and exact navigation | Live browser reporting workflow |
| 006 Platform Owner | Platform guard and admin component coverage | Authenticated platform administration journey |
| 007 Operations Admin | Platform guard, action contracts and admin components | Authenticated emergency-stop journey |
| 008 Billing Admin | HTTP and live platform billing suites | Authenticated reconciliation journey |
| 009 Support Admin | Scoped service, proxy and component evidence | Real authenticated diagnostics journey |
| 010 Technical Admin | HTTP permissions and admin component evidence | Authenticated troubleshooting journey |
| 011 Auditor | Fake-backed Auditor HTTP, route and admin navigation checks | Authenticated read-only browser journey |
| 012 Tenant isolation | 196 live tests passed with missing-tenant audit persistence verified | Custom-role enforcement is outside this completed tenant suite |
| 013 Sensitive audit | 30 live tests passed, including rollback and immutability | Broader authenticated browser audit journey |
| 014 Support access | Service, proxy and prior synthetic-API browser lifecycle verified | Authorized real authenticated browser E2E and related audit verification |
| 015 Enterprise governance | QA schema includes custom roles. Management routes, service isolation and creation form have automated coverage | Effective-permission review and integration, live role workflow, SSO and SCIM |

### Final regression commands and outcomes

| Command | Result |
|---|---|
| `npm.cmd run test --workspace @truevine/api -- authorization.guard.spec.ts route-guards.spec.ts --maxWorkers=1` | 352 passed across two files. The deliberately failing audit fake emitted the operational warning. |
| `node infrastructure/scripts/run-tenant-isolation-qa.mjs test:rbac-012 <approved fingerprint>` | 196 passed across 11 files. The three original denial-audit warnings did not recur. |
| `node infrastructure/scripts/run-tenant-isolation-qa.mjs test:rbac-013 <approved fingerprint>` | 30 passed, one file. |
| `npm.cmd run test --workspace @truevine/api -- --maxWorkers=1` | 952 passed across 47 files. Deliberate audit-failure tests emitted diagnostic logs. |
| `node infrastructure/scripts/run-tenant-isolation-qa.mjs verify <approved fingerprint>` | Live identity and all 23 migration ledger entries matched again after the tests. |
| `npm.cmd run test --workspace @truevine/web -- --maxWorkers=4` | 365 passed, three session tests timed out in one file. Vitest also reported a worker termination timeout. |
| `npm.cmd run test --workspace @truevine/admin -- --maxWorkers=4` | 139 passed across 19 files. |
| `npm.cmd run lint` | Exit 1 with 35 errors and one existing admin billing warning. Two launcher console errors were fixed. The other errors came from concurrent scratch scripts under `scripts/`, which were left in place. |
| `npm.cmd run typecheck` | Exit 0. |
| `npm.cmd run build` | Exit 0 for packages and all apps. The pre-build contents of the two Next.js generated declarations were restored. |
| `node --check infrastructure/scripts/run-approved-rbac-qa.mjs` and `node infrastructure/scripts/run-tenant-isolation-qa.mjs preflight` | Exit 0 after correcting the launcher output. Preflight opened no PostgreSQL connection. |
| `npm.cmd exec -- eslint apps/api/src/auth/organization.guard.ts apps/api/test/authorization.guard.spec.ts apps/api/test/authorization.e2e-spec.ts apps/api/test/tenant-isolation.e2e-spec.ts infrastructure/scripts/run-approved-rbac-qa.mjs` | Exit 0 after the launcher output correction. |
| `npm.cmd run test --workspace @truevine/web -- --maxWorkers=1` | All 368 passed across 29 files on serial retry with unchanged assertions and timeouts. |

The approved fingerprint is `904b7c6a30cba331cf88977d6042f04b65005fe25cbf571552e5ff7b2f3c9762`.

Files changed in this follow-up:

- `apps/api/src/auth/organization.guard.ts`
- `apps/api/test/authorization.guard.spec.ts`
- `apps/api/test/authorization.e2e-spec.ts`
- `apps/api/test/tenant-isolation.e2e-spec.ts`
- `infrastructure/scripts/run-approved-rbac-qa.mjs`
- `docs/rbac-001-015-master-implementation-verification-report.md`

The QA database and its append-only fixture evidence remain in place. Existing databases, credentials, environment settings and concurrent W3-03 files were preserved.

## Approved live QA execution — 2026-11-20

QA-only authorization covered database `truevine_rbac_qa_20261120_031000_4f92`, container `truevine-postgres`, host endpoint `127.0.0.1:55432`, and the exact 23-entry sequence listed below. Preflight confirmed the container, volume, publication, and approved input fingerprint. Creation exited 0. The launcher's read-only identity and empty-schema checks passed before Prisma ran. Prisma reported the expected database and endpoint and applied **all 23 migrations in order**, including both QA-only entries. The migration-stage ledger check and separate read-only checks immediately before RBAC-012 and after both live suites verified the exact 23 names, SQL checksums, successful completion, and absence of rolled-back rows. The temporary migration snapshot was removed.

| Control | Live outcome |
|---|---|
| RBAC-012 tenant isolation | **196 passed across 11 files, zero failures.** The existing tenant isolation, contacts, audio, campaigns, billing, call persistence, organization admin, authorization, contact groups, payment intents, and platform billing suites ran against the approved PostgreSQL database. Vitest emitted three authorization denial-audit warnings while the suites passed. Those warnings do not establish persistence for the affected denial path. |
| RBAC-013 sensitive audit | **30 passed in one file, zero failures.** The live suite included database-local injected audit failures, rollback behavior, and rollback-protected immutability probes. |
| RBAC-014 controlled support access | Authenticated browser E2E remains unexecuted pending authorized Support Admin access and suitable synthetic tenant fixtures. The prior Chrome evidence used a synthetic API. |

### Command evidence

Run from the repository root. In each launcher invocation below, `<fingerprint>` is `904b7c6a30cba331cf88977d6042f04b65005fe25cbf571552e5ff7b2f3c9762`.

| Command, in execution order | Result |
|---|---|
| `node infrastructure/scripts/run-tenant-isolation-qa.mjs preflight` | Exit 0. Endpoint and fingerprint matched. |
| `node infrastructure/scripts/run-tenant-isolation-qa.mjs create <fingerprint>` | Exit 0. Created the single approved disposable database. |
| `node infrastructure/scripts/run-tenant-isolation-qa.mjs migrate <fingerprint>` | Exit 0. Prisma applied 23 of 23 migrations. Post-migration ledger verification passed. |
| `node infrastructure/scripts/run-tenant-isolation-qa.mjs verify <fingerprint>` | Exit 0. Independent ledger and identity check passed. |
| `node infrastructure/scripts/run-tenant-isolation-qa.mjs test:rbac-012 <fingerprint>` | Exit 0. 196 passed, 11 files. |
| `node infrastructure/scripts/run-tenant-isolation-qa.mjs test:rbac-013 <fingerprint>` | Exit 0. 30 passed, one file. |
| `npm.cmd run test --workspace @truevine/api -- disposable-database.spec.ts support-access.service.spec.ts support-context-denial.http.spec.ts auditor.http.spec.ts --maxWorkers=1` | Exit 0. 43 passed, four files. |
| `npm.cmd exec -- vitest run --config infrastructure/vitest.config.mts run-tenant-isolation-qa.spec.ts --maxWorkers=1` | Exit 0. 2 passed, one file. |
| `node infrastructure/scripts/run-tenant-isolation-qa.mjs verify <fingerprint>` | Exit 0. Post-test identity and ledger verified again. |

Only this report changed in the execution pass. The disposable QA database remains in place. No operations targeted an existing database. Docker mappings, volumes, shared credentials, environment files, and W3-03 files were preserved. Full workspace lint, typecheck, and build were carried forward from the accepted baseline.

## Disposable RBAC QA database approval proposal — 2026-11-20

**Approval requested** for database `truevine_rbac_qa_20261120_031000_4f92` on `127.0.0.1:55432` (container `truevine-postgres`, internal port 5432, existing volume `truevine-postgres-data`), the 23 migrations below, and the exact-pair QA runner and guard changes. The proposed database name was absent in the read-only inventory. The endpoint and database pair are authorized. The migration sequence remains pending explicit QA-only approval.

### Conditional authorization and guard preparation

Docker confirmed the corrected publication on 127.0.0.1:55432. The dedicated guard mode accepts only the corrected host, port and database in test mode. The prepared launcher checks container and volume provenance and the migration fingerprint before connecting. It checks live database identity and an empty schema before migration, then checks the migration ledger before either test suite. No live stages were executed.

- `npm.cmd run test --workspace @truevine/api -- disposable-database.spec.ts --maxWorkers=1` passed all 24 guard tests.
- `npm.cmd exec -- vitest run --config infrastructure/vitest.config.mts run-tenant-isolation-qa.spec.ts --maxWorkers=1` passed both runner regression tests.
- `node --check` passed for both launcher modules. `node infrastructure/scripts/run-tenant-isolation-qa.mjs preflight` passed the container and 23-file fingerprint checks. Running the same command with `migrate` and no fingerprint exited 1 before connecting, as expected.

Changed `apps/api/test/disposable-database.ts`, `apps/api/test/disposable-database.spec.ts`, `infrastructure/scripts/run-tenant-isolation-qa.mjs`, `infrastructure/scripts/run-approved-rbac-qa.mjs`, `README.md`, and this report. Creation, migration, live ledger verification, RBAC-012 and RBAC-013 remain pending the migration approval. Authenticated RBAC-014 also needs the QA fixtures and sign-in described below.

### Preserve these existing databases

The maintenance query confirmed read-only mode and listed `postgres`, `template0`, `template1`, `rbac_security_20261119_1148_local`, `truevine_bootstrap_test_5b5b406c9ef94f1e`, `truevine_bootstrap_test_f68b202611190001`, and `truevine_voice`. Preserve all seven, including the existing test-looking names. The local `truevine` role already has database creation privileges and is a superuser. Treat the approved commands and exact target checks as the safety boundary because the credential itself has wider authority.

### Exact migration chain for a fresh database

Use Prisma's ordered deployment against the newly created, empty database, so the QA migration ledger is populated. The first 21 directories are listed in the release review manifest. `20261107120000_payment_intent_foundation` and `20261119134000_rbac_015_custom_roles` require specific QA-only approval here. The RBAC-012 payment tests and current application schema drive the full chain. Custom-role tables also allow follow-up database verification of RBAC-015 management. Its effective-permission integration remains subject to separate security approval.

```text
20261014042915_tenancy_core
20261016130500_identity_rbac_001
20261016141500_identity_audit_events
20261016142500_identity_audit_fk_restrict
20261016153000_organization_suspension
20261016170000_security_atomicity
20261016171000_invitation_origin
20261019120000_campaigns_rbac_003
20261019160000_customer_billing_rbac_004
20261020110000_rbac_007_emergency_stop
20261020180000_platform_owner_bootstrap
20261020181000_platform_owner_bootstrap_no_truncate
20261020182000_platform_owner_bootstrap_search_path
20261021120000_call_persistence
20261021150000_sensitive_audit_integrity
20261022110000_rbac_014_support_access_sessions
20261022120000_contacts_groups_import_w2_02
20261024180000_audio_assets_w3_02
20261025100000_audio_usage_trigger_error_mapping
20261025110000_campaign_builder_w3_03
20261030120000_payment_provider_configuration
20261107120000_payment_intent_foundation
20261119134000_rbac_015_custom_roles
```

SQL review found database-local schema and integrity changes, including a membership enum conversion followed by dropping its superseded type, replacement of an audit foreign key, the database-local `citext` extension, and triggers that enforce immutability or related-row constraints. No active database/role creation, database drops, cross-database access mechanisms, or top-level data truncation were identified. The W3-03 migration is read-only review input for this proposal. The reviewed chain fingerprint is `904b7c6a30cba331cf88977d6042f04b65005fe25cbf571552e5ff7b2f3c9762`. It hashes sorted lines of `directory-name SHA256(normalized migration.sql)`, with LF line endings and a trailing LF.

### Proposed Windows CMD execution after approval

The launcher is available through the existing root npm command. Supply the explicitly approved fingerprint as RBAC_QA_APPROVED_SHA256 only after approval.

```cmd
cd /d F:\TruevineVoice
npm.cmd run test:rbac-012:qa -- preflight
npm.cmd run test:rbac-012:qa -- create "%RBAC_QA_APPROVED_SHA256%"
npm.cmd run test:rbac-012:qa -- migrate "%RBAC_QA_APPROVED_SHA256%"
npm.cmd run test:rbac-012:qa -- verify "%RBAC_QA_APPROVED_SHA256%"
npm.cmd run test:rbac-012:qa -- test:rbac-012 "%RBAC_QA_APPROVED_SHA256%"
npm.cmd run test:rbac-012:qa -- test:rbac-013 "%RBAC_QA_APPROVED_SHA256%"
```

Stop at the first failed command. Use the repository-pinned Node version. The reviewed launcher contract is as follows.

- `preflight` verifies Docker context, container, volume, mapping, and migration fingerprint without opening a database connection. The create operation fails if the name exists. It derives credentials privately from the existing local configuration, requires the expected loopback source endpoint and rejects routing options. It hands child processes a freshly constructed URL for the new database only, via subprocess environment.
- `create` repeats the provenance checks and runs the exact invocation `docker exec truevine-postgres createdb -w -U truevine --maintenance-db=postgres --template=template0 truevine_rbac_qa_20261120_031000_4f92`. PostgreSQL rejects a name collision. The maintenance connection performs only this cluster catalog operation. Existing data, templates, roles and credentials are preserved. A failed creation stops execution.
- `migrate` connects through `127.0.0.1:55432`, verifies `current_database()` and an empty application schema, freezes the checked migration inputs for the duration of the run and invokes the installed Prisma CLI with `migrate deploy --config <private snapshot config>` and the pinned process-local URL. The private migration snapshot must contain only the approved SQL chain, schema and config and must be the actual Prisma input. No fallback on missing configuration. `verify` checks name and all 23 migration ledger rows and checksums with a read-only connection before running fixtures.
- The dedicated QA mode in `apps/api/test/disposable-database.ts` that accepts only `NODE_ENV=test`, the new database name and `127.0.0.1:55432`, with routing options refused and the live database identity check retained. Add negative tests for the development name, every wrong endpoint/name combination, and missing opt-in. Preserve the legacy `55432` branches. Reuse the existing RBAC-012 runner's selected suite list through the new mode. Run the suites serially after repeating the read-only preflight. The RBAC-013 subprocess runs `sensitive-audit.e2e-spec.ts` through the API E2E configuration with one worker with `SENSITIVE_AUDIT_DISPOSABLE=1` and the exact QA mode.
- RBAC-012 writes synthetic records only. The full RBAC-013 suite adds test-local trigger objects, exercises transaction rollback, and probes audit UPDATE, DELETE and TRUNCATE inside the new database. Include those operations in approval and run it exclusively on that target. Neither command creates, resets, or drops a database. Leave the QA database in place for evidence after the runs.

### Authenticated RBAC-014

The support-session migration is in the chain. Real browser verification still needs a QA-only Support Admin and synthetic tenant fixtures provisioned through an approved application workflow, a real API launched with the exact QA URL and `EXPECTED_DATABASE_NAME`, and a working Next.js admin build pointed at that API. Keep credential provisioning separate and preserve existing accounts. Confirm matched and cross-tenant diagnostics, capability HttpOnly behavior, expiry and revocation in an isolated browser session. The earlier synthetic API browser verification is separate evidence.

### Checks performed for this proposal

- Read-only `docker exec` PostgreSQL maintenance catalog query returned all seven existing databases and confirmed `transaction_read_only=on`. Repository reads enumerated and fingerprinted 23 migration files and inspected the Prisma config, runner, guard, manifest and DDL.
- `npm.cmd run test --workspace @truevine/api -- disposable-database support-access.service support-context-denial auditor.http --maxWorkers=1` returned 40 passes and one support-context setup timeout. `npm.cmd run test --workspace @truevine/api -- support-context-denial.http.spec.ts --maxWorkers=1` passed all three tests on isolated retry with the existing timeout.
- Only this report changed during the original proposal. The previous lint, typecheck and build baseline was carried forward at that stage. Database creation, migrations, database-backed tests and authenticated E2E remain pending. No shared configuration or W3-03 files changed.

## Infrastructure recovery follow-up — 2026-11-20

Docker Desktop 4.100.0 and its Linux Docker Engine 29.9.3 were reachable at the start of this follow-up. WSL reported the `docker-desktop` distribution running under WSL 2, and `docker desktop status` reported running. The Windows `com.docker.service` remained stopped even with the Linux engine responding. The earlier missing Linux named pipe established an outage at that time. The available observations do not establish what originally stopped the engine or restored it. Both Docker contexts returned the same live engine ID. No engine, service, or container was restarted by this pass.

The existing `truevine-postgres` container was running and healthy, backed by `truevine-postgres-data`. Inspection and the Windows listener check showed `127.0.0.1:55600 → 5432/tcp`. There was no listener on `55432`. No other PostgreSQL container appeared in the engine inventory. A connection inside the mapped container to the approved database name `truevine_bootstrap_test_a1b2c3d4e5f67890` returned PostgreSQL's database-does-not-exist error. A separate read-only query in the maintenance database confirmed the approved database was absent and `truevine_voice` was present. The QA migration ledger therefore could not be inspected.

**Database-backed testing remains blocked.** Provide a reachable, pre-existing, already-migrated disposable database on the approved `127.0.0.1:55432` endpoint. If a verified disposable database is instead made available on `127.0.0.1:55600`, explicit approval is required for the exact endpoint and database pair and a narrowly scoped change to the QA runner and disposable guard. The current instance lacks the approved database, so a port-only approval cannot unblock it. The full RBAC-013 suite additionally requires a disposable target approved for its trigger installation and rollback-protected immutability probes. Authenticated RBAC-014 requires a verified QA API target with the support-session migration and authorized Support Admin sign-in. The previous synthetic browser evidence remains unchanged.

| Commands and checks, in execution order | Result |
|---|---|
| `docker context ls`, `docker --context desktop-linux version`, `Get-Service`, `Get-Process`, `wsl.exe --list --verbose` | Linux server reachable. Docker WSL distribution running. |
| `docker --context desktop-linux compose ps -a`, `docker --context desktop-linux ps -a`, `docker --context desktop-linux inspect`, `Get-NetTCPConnection -LocalPort 55432,55600 -State Listen`, `docker --context default version` | Healthy PostgreSQL container, verified data volume, only the 55600 listener, default context reachable. |
| `npm.cmd run test --workspace @truevine/api -- disposable-database support-access.service support-context-denial auditor.http --maxWorkers=1` | 41 passed across 4 files. PostgreSQL-independent unit and fake-backed HTTP regressions. |
| `docker --context desktop-linux exec --env PGOPTIONS=-cdefault_transaction_read_only=on truevine-postgres psql -X -w -U truevine -d truevine_bootstrap_test_a1b2c3d4e5f67890` with read-only identity and ledger queries | Exit 2. PostgreSQL rejected the connection because the named database does not exist. |
| Same read-only in-container client against maintenance database `postgres`, with a `pg_database` existence check | Returned `postgres\|on\|f\|t`. The session was read-only, the approved QA name was absent, and the development database existed. |
| `docker --context desktop-linux info`, `docker --context default info`, `docker desktop status`, `docker volume ls`, and relevant Windows service event metadata query | Contexts point to the same engine. Desktop running. No matching service event established the earlier outage cause. |

Only the master report changed. Build, lint and typecheck results carry forward from the accepted baseline. No live RBAC-012, RBAC-013 or authenticated RBAC-014 tests ran. No Docker settings, database contents, environment files, credentials, shared configuration, or W3-03 files were changed.

## Live verification follow-up — 2026-11-20

| Control | Current outcome |
|---|---|
| RBAC-012 tenant isolation | Live tests stopped before connecting. Database identity and migration state could not be verified. The focused disposable-target and authorization regressions ran with unit/fake-backed configuration. |
| RBAC-013 sensitive audit | Live persistence and immutability remain unverified. The support denial audit regression and fake-backed Auditor HTTP suite ran. The latter passed on isolated retry. |
| RBAC-014 controlled support access | Real authenticated browser E2E did not run. The prior Chrome result remains evidence for the production admin build and synthetic API only. Support and proxy regression tests passed. |

The local Compose configuration and the redacted database endpoint configuration both select loopback port `55600`. This explains the earlier published port. The approved RBAC-012 runner and shared disposable guard explicitly require `55432` and the runner pins the database name to `truevine_bootstrap_test_a1b2c3d4e5f67890`. On this follow-up, `docker compose ps` could not reach the Docker Desktop Linux engine. The Windows Docker service was stopped and both PostgreSQL loopback ports returned `ECONNREFUSED`. The configured port alone establishes neither a current mapping nor the identity of the database behind it.

To proceed with the existing RBAC-012 approval, restore access to the documented endpoint on `55432` without changing the current Compose mapping as part of this task. Using `55600` instead requires explicit approval for an exact loopback endpoint and database pair, plus review of a narrowly scoped change to the port guard. Before authorizing fixture writes on either endpoint, confirm the Docker container and volume provenance, query `current_database()` and inspect applied migration names, checksums and completion state read-only against the reviewed test manifest. The existing RBAC-012 approval covers its named fixture suites. The full sensitive-audit suite temporarily installs triggers and attempts audit-table truncation inside a rollback transaction. It needs a separately approved, already-migrated disposable database suitable for those operations, or review of a persistence-only suite using isolated fixtures. Real RBAC-014 needs a verified QA API target with the support-session migration and an authorized Support Admin sign-in using existing credentials. The documented customer, API and admin ports and prior smoke ports all refused TCP connections in this pass.

| Commands and checks, in execution order | Result |
|---|---|
| `git status --short`, `rg` and file reads for the report, runner, guards, ADRs and tests, then `docker compose ps` | Existing W3-03 work identified. Docker engine pipe unavailable. |
| `Get-NetTCPConnection -LocalPort 55432,55600 -State Listen`, `Get-Service com.docker.service`, `docker context show` | No listeners returned. Service stopped. Context `desktop-linux`. |
| `npm.cmd run test --workspace @truevine/api -- tenant-isolation disposable-database authorization.guard route-guards auditor.http support-context-denial support-access.service --maxWorkers=1` | 5 files passed, 1 failed. 392 passed, 1 timed out at the existing 5-second limit in Auditor read auditing. The workspace's default unit configuration did not run live PostgreSQL E2E. |
| `npm.cmd run test --workspace @truevine/admin -- proxy.spec.ts support/access/page.spec.tsx PlatformShell.spec.ts --maxWorkers=1` | 4 files, 20 passed. |
| Node TCP probes for ports `55432`, `55600`, `3000`, `3001`, `3002`, `3107`, and `3108` | All refused connections. |
| Redacted, read-only `POSTGRES_PORT` and `DATABASE_URL` endpoint inspection | Both select port `55600`. No credentials emitted. |
| `npm.cmd run test --workspace @truevine/api -- auditor.http.spec.ts --maxWorkers=1` | Isolated retry passed all 8 tests with the same assertions and timeout. |

The only file changed in this pass was `docs/rbac-001-015-master-implementation-verification-report.md`. The accepted build, lint and typecheck baseline was carried forward for this report-only update. Database-backed tests and browser E2E were deferred at the identity gate. No database, migration, Docker mapping, environment file, credential, or W3-03 file was changed.

The repository-wide git diff whitespace check reported five trailing-whitespace lines in concurrent W3-03 campaign files. The report section passed a separate trailing-whitespace check.

## Follow-up remediation and verification — 2026-11-19

The original audit is retained below as the baseline. The admin test runner is restored. New coverage verifies exact customer navigation, custom-role route guards and foreign-tenant role concealment, and the support denial audit payload.

| ID | Backend | Frontend | Security and automated evidence | Browser | Remaining blocker |
|---|---|---|---|---|---|
| 001 Owner | Organization and ownership routes present | Exact Owner menu covered | API route/guard suite and customer navigation passed | Current authenticated journey pending | Ownership transfer and denial journey |
| 002 Admin | Delegated organization routes present | Exact Admin menu covered | API route/guard suite and customer navigation passed | Authenticated journey pending | Live delegation and ownership transfer denial |
| 003 Campaign Manager | Contacts, audio and draft campaigns present | Exact Campaign Manager menu covered | Campaign Manager HTTP and navigation suites passed | Authenticated journey pending | Live draft workflow and complete prohibited-operation evidence. Execution remains outside the implemented draft flow |
| 004 Billing | Scoped billing routes present | Exact Billing menu covered | Billing HTTP and navigation suites passed | Authenticated journey pending | Database-backed billing and live billing workflow |
| 005 Viewer | Campaign and reporting reads present | Exact Viewer menu covered | Read-only guard and navigation suites passed | Authenticated journey pending | Live reports and mutation-denial journey |
| 006 Platform Owner | Administration routes present | Platform Owner menu covered | Platform guard and admin suites passed | Authenticated journey pending | Live admin transitions and persisted audit |
| 007 Operations Admin | Operations routes and emergency stop present | Operations Admin menu covered | Platform guard, route contracts, and admin component suites passed | Authenticated journey pending | Live emergency stop and delegated-denial journey |
| 008 Billing Admin | Platform billing routes present | Billing Admin menu and wallet UI covered | Billing Admin HTTP tests and admin suites passed | Authenticated journey pending | Live reconciliation, ledger and audit |
| 009 Support Admin | Customer lookup and scoped diagnostics present | Support Admin menu and support UI covered | Support context denial and admin tests passed | Authenticated journey pending | Live diagnostics and denial matrix |
| 010 Technical Admin | Diagnostic reads present | Technical Admin menu and pages covered | Technical HTTP and admin suites passed | Authenticated journey pending | Live troubleshooting and escalation-denial journey |
| 011 Auditor | Read-only audit routes present | Auditor menu and pages covered | Auditor HTTP, guard and admin suites passed | Authenticated journey pending | Live read-only workflow |
| 012 Tenant isolation | Scoped guards and repositories present | Customer routes preserve selected tenant | API guards and isolated custom-role concealment passed. Approved PostgreSQL runner stopped before tests | Live cross-tenant journeys pending | Pinned QA PostgreSQL requires loopback 55432. The running container publishes 55600. Custom-role SQL also requires migration review |
| 013 Sensitive audit | Audit persistence and existing PostgreSQL E2E tests present | Related platform actions present | Support denial asserts actor, target organization, action, reason and outcome. Existing PostgreSQL E2E defines before/after, timestamps and immutability checks | Authenticated audit journey pending | Dedicated approved disposable target for trigger and mutation tests |
| 014 Support access | Session management, capability validation and audit present | Support access page and Next.js proxy present | Service, support context denial, component and proxy cookie tests passed | Chrome passed session creation, listing, diagnostics, expiry, revocation, HttpOnly visibility and foreign-tenant denial against a synthetic upstream | Live authenticated role, database-backed enforcement and audit |
| 015 Enterprise | Custom-role admin endpoints and pending migration present | Custom-role workflow routes present | All eight route contracts covered. Foreign role operations return 404 and preserve state in the service test. The create form now toggles only delegable permissions and covers success and API denial | Authenticated workflows pending | Migration approval, central effective-permission security approval, IdP interoperability and SCIM provisioning verification |

### Follow-up commands and results

| Command | Result |
|---|---|
| `npm.cmd run test --workspace @truevine/admin -- --maxWorkers=1` | First consolidated configuration exposed the unsupported Oxc JSX override. 19 setup failures, zero tests. The override was removed so the TypeScript JSX configuration controls the transform. |
| `npm.cmd run test --workspace @truevine/web -- AppNavigation.spec.tsx --maxWorkers=1` | Initial run passed 6 baseline cases after the first file-edit command failed on a Windows PowerShell encoding option. After applying the edit and running Prettier, 10 passed. |
| `npm.cmd run lint` | Exit 0. One existing `react-hooks/exhaustive-deps` warning in the admin billing page. |
| `npm.cmd run test --workspace @truevine/api -- route-guards.spec.ts authorization.guard.spec.ts billing-admin.http.spec.ts technical.http.spec.ts auditor.http.spec.ts support-context-denial.http.spec.ts support-access.service.spec.ts custom-role --maxWorkers=1` | 443 passed across 9 files. Expected simulated audit-failure logs appeared. |
| `npm.cmd install --workspace @truevine/admin --save-dev --save-exact --ignore-scripts --no-audit --no-fund @testing-library/jest-dom@6.9.1` | Native Windows npm shim used Node 26.13.1 and failed the repository engine check, including under `npm exec`. |
| `npm.cmd exec --yes --package=node@24.19.0 -- node --version` | Confirmed v24.19.0. |
| `npm.cmd run test --workspace @truevine/api -- custom-role.service.spec.ts --maxWorkers=1` | 23 passed. |
| `npm.cmd exec --yes --package=node@24.19.0 -- node "C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js" install --workspace @truevine/admin --save-dev --save-exact --ignore-scripts --no-audit --no-fund @testing-library/jest-dom@6.9.1` | Installed 8 packages, with existing ESLint peer-range warnings. The manifest and lockfile diff consists of the admin test dependency and its dependency tree. |
| `npm.cmd run test --workspace @truevine/admin -- --maxWorkers=4` | 139 passed across 19 files. |
| `npm.cmd run typecheck` | Exit 0 across workspaces. |
| `npm.cmd run test --workspace @truevine/api -- route-guards.spec.ts --maxWorkers=1` | 37 passed. |
| `npm.cmd run test:rbac-012:qa` | Exit 1 before suites started. Package builds passed. The pinned target preflight failed. Read-only port and Compose checks showed PostgreSQL published on 55600 with no listener on 55432. |
| `npm.cmd run test --workspace @truevine/web -- --maxWorkers=4` | 366 passed across 28 files. |
| `npm.cmd run test --workspace @truevine/api -- --maxWorkers=4` | 948 passed across 47 files. Expected simulated audit-failure logs appeared. |
| `npm.cmd run test --workspace @truevine/api -- support-access.service.spec.ts --maxWorkers=1` | First assertion used an incorrect reason label and yielded 7 passes and 1 failure. Corrected to the current contract, `invalid_request`. Rerun passed all 8. |
| `npm.cmd run build` | Exit 0 for packages, API, worker, web and admin before the subsequent custom-role form edit. |
| `$env:VITEST_MAX_THREADS='4'; npm.cmd test` | Exit 1. Vitest 5 did not use this worker setting. Admin passed 139, web passed 366, and API passed 946 with 2 timeouts in Auditor and Billing Admin HTTP cases. Deployment tests did not run. |
| `npm.cmd run test --workspace @truevine/web -- CreateRoleForm.spec.tsx --maxWorkers=1` | 2 passed, covering tenant-scoped success, category choose/clear, and server denial. |
| `npm.cmd run build --workspace @truevine/web` | Exit 0 after the final custom-role form change. |
| `npm.cmd run typecheck --workspace @truevine/web` | Exit 0 after the final custom-role form change. |
| `npm.cmd run prisma:validate` | Exit 0. Prisma schema is valid. |
| `$env:VITEST_MAX_WORKERS='4'; npm.cmd test` | Exit 1. Admin passed 139, web passed 368, and API reported 945 passes and 3 timeouts in Auditor, Billing Admin and Contacts HTTP tests. All other workspace suites passed. Deployment tests did not run in this invocation. |
| `npm.cmd run lint` (final) | Exit 0 with the same admin billing hook warning. |
| `npm.cmd run test --workspace @truevine/api -- --maxWorkers=1` | Final serial run passed all 948 tests across 47 files, including the cases that timed out in the root runs. |
| `$env:VITEST_MAX_WORKERS='2'; npm.cmd run test:deployment` | Exit 0. 379 passed and 3 skipped across 17 files. The existing db-verify and backup runtime wrappers reported Linux-only skips on Windows. |

### RBAC-014 browser evidence

The production admin build started with `TRUEVINE_API_URL=http://127.0.0.1:3116` and `npm.cmd run start --workspace @truevine/admin -- --port 3117 --hostname 127.0.0.2`. A temporary Node HTTP fixture on 3116 represented the Support Admin API without credentials or a database. Chrome opened `/admin/support/access` and created and listed a session for Synthetic Alpha. The matching diagnostics request returned 200. The foreign tenant returned 403, and the fixture confirmed that the proxy did not forward the capability. The browser could not read the capability through `document.cookie` even when the document path matched the cookie path. Revocation updated the visible row to Revoked and denied a subsequent diagnostics request with no capability forwarded. A second fixture session used a 15-second TTL to verify browser expiry, the Expired row, and a diagnostics 403 with no capability forwarded. The first expiry selector matched both the filter option and the table row. A table-scoped check confirmed the visible Expired state. The browser tab and both fixture processes were closed.

This run exercises the real production build, browser and proxy. Live PostgreSQL session enforcement, audit persistence and authenticated platform role journeys remain open.

### RBAC-015 migration and permission review

The pending `20261119134000_rbac_015_custom_roles` SQL creates three tables and a role-type enum. Composite foreign keys tie each permission and assignment to its tenant role and each assignee to a membership in the same tenant. The migration header overstates the lack of interaction with existing tables. Foreign-key creation references and can lock the organization and membership tables. Its final comment mentions a CHECK, while the SQL adds a foreign key. Review should confirm DDL lock impact, schema parity, same-tenant foreign-key rejection, cascade behavior, clean application on an approved disposable clone, and a recovery plan that accounts for existing assignments. Migration approval and application remain outstanding.

Central effective permissions require an explicit decision approving the union of fresh builtin and custom grants for the authenticated, active membership in the path tenant. Review must also approve a deny-by-default policy for unavailable or invalid grant data, a nondelegable set for ownership and privilege-management operations, revocation semantics, transaction-boundary rechecks under the same locks as role and membership mutations, and an audit and rollback plan. Platform permissions stay governed exclusively by platform assignments. Existing builtin permissions, protected transitions and both security planes require regression evidence before rollout. SSO and SCIM require reviewed trust, identity-linking, tenant binding, token lifecycle and lifecycle semantics, plus interoperability evidence from an approved external IdP. Authentication and provisioning remain disabled.

### Files changed in this follow-up

- `apps/admin/package.json`
- `apps/admin/vitest.config.mts`
- `apps/admin/vitest.config.ts` (removed duplicate)
- `apps/admin/vitest.setup.ts`
- `apps/api/src/custom-roles/custom-role.service.spec.ts`
- `apps/api/src/support/support-access.service.spec.ts`
- `apps/api/test/route-guards.spec.ts`
- `apps/web/src/app/app/AppNavigation.spec.tsx`
- `apps/web/src/app/app/roles/create/CreateRoleForm.tsx`
- `apps/web/src/app/app/roles/create/CreateRoleForm.spec.tsx`
- `docs/rbac-001-015-master-implementation-verification-report.md`
- `package-lock.json`

## Original verification baseline


## Executive summary

This pass examined evidence for all 15 tracker IDs. Zero controls met the full acceptance bar across source, API, database, and role-specific browser journeys. Fourteen controls have partial evidence. RBAC-015 is blocked as a complete Enterprise feature because custom-role management exists in the working tree, effective permission enforcement has not been integrated, and SSO/SCIM are absent. The API workspace suite passed 946 tests and the customer web workspace suite passed 362. No application source, database schema, migration, role assignment, or credential was changed in this pass.

An earlier compiled API startup failed because the custom-role module referenced a `.ts` file. Concurrent changes corrected that import during this pass. The rebuilt API started on loopback and passed the health smoke check. An earlier live authentication journey passed 23 checks before local email capture stopped invitation and password-reset verification. Admin component tests are currently blocked by a missing test dependency.

## Control matrix

| ID | Backend | Frontend | API security | Tests | Evidence | Remaining gaps |
|---|---|---|---|---|---|---|
| 001 Owner | Implemented but unverified in full | Team, settings, campaigns and billing routes present | Partial | Focused guard baseline passed | Organization controller, earlier Owner activation journey | Ownership actions and full role journey on current tree |
| 002 Admin | Implemented but unverified in full | Delegated organization workflows present | Partial | Focused guard baseline passed | Route guards, contacts/audio HTTP suites | Full delegated allow/deny journey and ownership transfer denial |
| 003 Campaign Manager | Partial | Contacts, audio and campaigns present | Partial | Focused HTTP suite passed | `campaign-manager.http.spec.ts` and campaign service tests | Live execution/results and complete prohibited-operation matrix |
| 004 Billing | Partial | `/app/billing` present | Partial | Billing HTTP suite passed | `billing.http.spec.ts` | Billing-only journey and complete cross-role denials |
| 005 Viewer / Analyst | Partial | Dashboard/reports present | Partial | Focused guard baseline passed | Route guards and authorization guard | Enumerate and test every relevant mutation and reports flow |
| 006 Platform Owner | Partial | `/platform-admin` and `/settings` present | Partial | Focused guard baseline passed | Platform administrator controller requires management permission | Live pilot workflows, escalation denial, protected transition audit |
| 007 Operations Admin | Partial | Admin entry exists | Implemented but unverified in full | Role-specific suite not run | Operations controller read/write permissions | Emergency stop and delegated pricing/financial/administrator denials |
| 008 Billing Admin | Partial | `/billing` present | Implemented but unverified in full | Role-specific suite not run | Billing administrator controller read/refund permissions | Reconciliation, ledger and audit workflow, financial deny matrix |
| 009 Support Admin | Partial | `/support`, customer/user lookup and diagnostics present | Partial | Support denial and session service passed | Support controller permission split | Full live diagnostics, support history, unrelated mutation denials |
| 010 Technical Admin | Partial | `/technical` and provider/queue/log/audit routes present | Implemented but unverified in full | Role-specific suite not run | Technical controller read/audit permissions | Live troubleshooting, financial and escalation denials |
| 011 Auditor | Partial | `/auditor`, audit and organizations present | Partial | Auditor HTTP spec passed | `auditor.http.spec.ts` | Exhaustive privileged mutation denials and browser matrix |
| 012 Tenant isolation | Partial | Organization-scoped customer navigation present | Partial | Focused guard and support denial specs passed | Existing database E2E source located | Database-backed tenant test, filtering/pagination, custom roles, enterprise integration |
| 013 Sensitive action audit | Partial | Sensitive platform workflows present in related routes | Partial | Focused guard and support service passed | Audit controller, existing sensitive-audit E2E source | Field-by-field mutation records, storage immutability and matrix coverage |
| 014 Controlled support access | Partial | App-relative `/support/access` present | Partial | Session service and denial HTTP spec passed | `support.controller.ts`, support access page, ADR 0021 | Database and browser verification for session lifecycle, HttpOnly capability and tenant boundary |
| 015 Enterprise governance | Blocked for complete delivery | `/app/roles` management routes present. SSO/SCIM missing | Partial for custom-role management | Custom-role unit specs passed | Custom role controller, migration, RBAC-015 working report | Migration review, approved guard integration, SSO and SCIM implementation and interoperability |

## Files changed

- `docs/rbac-001-015-master-implementation-verification-report.md` records current evidence and release gaps.
- `apps/web/src/app/app/AppNavigation.spec.tsx` adds the existing customer Roles & Permissions entry to the exact Owner menu expectation. The test still checks all destinations stay under `/app` and exclude platform links.

## API inventory and test coverage

These route families were inspected. A passing suite applies to that suite’s assertions only. Full per-endpoint outcome mapping remains open.

| Route family | Methods and permission evidence | Tested outcome in this pass |
|---|---|---|
| `/organizations/:organizationId` and organization billing, campaigns, contacts, groups, audio | Resource-specific reads and writes using organization guards and route permissions | Focused HTTP and guard suite passed |
| `/platform/admin/*` | Platform admin reads and mutations require `platform:admin:manage` | Guard baseline only |
| `/platform/operations/*` | GET operations data uses `platform:operations:read` or `platform:tenant:read`. Mutation uses `platform:operations:write` | Dedicated workflow not run |
| `/platform/billing/*` | GET uses `platform:billing:read`. Refund uses `platform:billing:refund` | Dedicated workflow not run |
| `/platform/technical/*` | GET uses `platform:technical:read` or `platform:audit:read` | Dedicated workflow not run |
| `/platform/audit/*` | GET requires `platform:audit:read` or `platform:tenant:read` | Auditor HTTP suite passed |
| `/platform/support/sessions` and `/sessions/terminate` under the same prefix | GET/POST sessions and POST termination require `platform:support:access`. Mutations use CSRF guard | Session service and support context denial suites passed |
| `/platform/support/organizations/:organizationId/diagnostics` | GET requires `platform:support:diagnostics` and `SupportAccessGuard` | Focused denial suite passed. Live capability cookies not exercised |
| `/organizations/:organizationId/roles` and `/:roleId` | GET/POST collection and GET/PATCH/DELETE item require `organization:update` and accepted terms | Unit coverage passed. Direct HTTP coverage not established |
| `/organizations/:organizationId/roles/:roleId/assignments` | GET requires `organization:update`. POST and DELETE `/:userId` require `member:update` | Unit coverage passed. Direct HTTP coverage not established |

## Frontend inventory

Platform admin paths in the table are app-relative. The public URL prefixes them with `/admin`.

| Application | Routes inspected | Role workflows requiring live verification |
|---|---|---|
| Customer | `/app`, `/app/team`, `/app/settings`, `/app/campaigns`, `/app/contacts`, `/app/contact-groups`, `/app/audio`, `/app/billing`, `/app/reports` | Owner management, Admin delegation, Campaign Manager execution, Billing-only actions, Viewer read-only navigation |
| Customer | `/app/roles`, `/app/roles/create`, `/app/roles/[roleId]`, `/app/roles/[roleId]/edit`, `/app/roles/[roleId]/assign` | Custom role CRUD, assignment, denial and effective permissions |
| Platform admin | `/`, `/platform-admin`, `/settings`, `/settings/payments`, `/billing` | Platform Owner administration, Operations workflow and Billing Admin reconciliation |
| Platform admin | `/support`, `/support/customers`, `/support/users`, `/support/diagnostics`, `/support/access` | Support lookup, 15-minute diagnostics access and revocation |
| Platform admin | `/technical`, `/technical/providers`, `/technical/queues`, `/technical/logs`, `/technical/audit`, `/auditor`, `/auditor/audit`, `/auditor/organizations` | Technical diagnostics and Auditor read-only workflows |

## Automated test evidence

| Command | Result |
|---|---|
| `npm.cmd run test:rbac-003 -- --maxWorkers=1` | Package builds passed. 9 files and 497 tests passed. The run logged `[authorization] Denial audit unavailable.` and does not establish database audit persistence. |
| `npm.cmd run test --workspace @truevine/api -- auditor.http.spec.ts support-context-denial.http.spec.ts support-access.service.spec.ts custom-role --maxWorkers=1` | 5 files and 66 tests passed. |
| `npm.cmd run test --workspace @truevine/admin -- --maxWorkers=1` | 19 suites failed setup. Zero tests ran. The shared setup imports `@testing-library/jest-dom`, which is absent from the admin manifest and lockfile. Vite also warned that its native config loader cannot load the current ESM syntax from a CommonJS config. |
| `npm.cmd run test --workspace @truevine/web -- --maxWorkers=1` | Initial run passed 361 tests and failed 1 across 28 files. The Owner menu assertion predates the customer Roles & Permissions entry. |
| `npm.cmd run test --workspace @truevine/web -- AppNavigation.spec.tsx --maxWorkers=1` | 6 tests passed after updating the exact menu expectation. |
| `npm.cmd run typecheck` | Workspace typechecks and package compilation completed without diagnostics. |
| `npm.cmd run lint` | Exit 0. One existing `react-hooks/exhaustive-deps` warning in `apps/admin/src/app/billing/page.tsx:127`. |
| `npm.cmd run test --workspace @truevine/web -- --maxWorkers=1` (rerun) | 28 files and 362 tests passed. |
| `npm.cmd run build` | Packages, API, worker, customer web and admin builds passed. The build listed both custom roles and support access routes. |
| `npm.cmd run test --workspace @truevine/api -- --maxWorkers=1` | 47 files and 946 tests passed, including the focused API coverage above. Logs included deliberate audit-failure cases. |
| `set API_PORT=3107&& set API_HOST=127.0.0.1&& set EMAIL_TRANSPORT=none&& npm.cmd run start:api` | Compiled API started. Read-only `curl.exe` checks returned 200 for `/health` and 401 for unauthenticated GETs to `/platform/support/sessions` and `/platform/audit/audit`. |
| `set TRUEVINE_API_URL=http://127.0.0.1:3107&& npm.cmd run start --workspace @truevine/admin -- --port 3108 --hostname 127.0.0.1` | Compiled admin started. Unauthenticated HTTP GETs returned 200 for the page shells at `/admin/support/access`, `/admin/auditor`, and `/admin/technical`. Paths without the configured `/admin` prefix returned 404. The customer `/sign-in` on port 3000 returned 200. Access to a page shell does not verify its authenticated data and actions. |

## Security and release assessment

The inspected routes use separate organization and platform permission decorators. The focused suites supply regression evidence for guard decisions and support denial. They do not establish cross-tenant database behavior, every escalation path, audit immutability, or browser cookie handling. The custom-role report explicitly identifies central guard integration as pending review. See [RBAC-015 working report](rbac-015-enterprise-governance-implementation-report.md), [controlled support access ADR](adr/0021-controlled-support-access.md) and [tenant isolation ADR](adr/0019-tenant-isolation-write-authorization.md).

| Severity | IDs | Blocker and resolution |
|---|---|---|
| Critical release gate | 012 | Use a reviewed disposable database target for database-backed isolation verification. Existing databases and migrations are outside the authorization for this pass. |
| High | 006–014 | Role-specific platform browser journeys and database-backed sensitive audit/support checks remain open. Review applicable migrations before applying to an approved target. |
| High | 006–014 | Admin tests cannot load. Coordinate the missing `@testing-library/jest-dom` dependency and lockfile update with the owner of the in-progress admin dependency changes. |
| Enterprise | 015 | Review `20261119134000_rbac_015_custom_roles` before application. Obtain explicit security review before enabling changes to central effective-permission evaluation. SSO and SCIM require reviewed implementation and actual external interoperability tests. |

The baseline is suitable for continued QA. MVP release acceptance remains open pending tenant isolation, sensitive action audit and role-specific browser evidence. Enterprise/V2 is not ready for release testing and is outside the MVP release gate.

## Manual testing guide for Windows CMD

From `F:\TruevineVoice`, check the infrastructure and start the apps in separate terminals:

```cmd
cd /d F:\TruevineVoice
docker compose ps
npm.cmd run dev:api
npm.cmd run dev:web
npm.cmd run dev:admin
```

Confirm `http://localhost:3001/health`. Use `http://localhost:3000/sign-in` for customer roles and `http://localhost:3002/admin` for platform roles. The customer QA inventory includes `qa-owner@example.invalid` (Owner), `qa-admin@example.invalid` (Admin), `qa-campaign-manager@example.invalid` (Campaign Manager), `qa-billing@example.invalid` (Billing), and `qa-viewer@example.invalid` (Viewer). Use the authorized platform inventory and credential storage in the [QA role matrix](qa-role-permission-matrix.md), [local organization provisioning runbook](runbooks/local-org-qa-provisioning.md), and [platform account recovery runbook](runbooks/local-qa-platform-recovery.md). Passwords are kept out of this report.

For each customer role, sign in with a separate browser session, open `/app`, and compare visible navigation and permitted actions with rows 001–005. For each platform role, open its route in the frontend inventory and check the positive workflow and protected route handling against rows 006–011. For support access, use an approved QA organization and verify justification, expiration, revocation and denied cross-organization diagnostics. For each approved role journey, repeat at desktop, tablet and mobile widths, verify keyboard focus and validation, then refresh and sign out. Run direct authorization checks through the repository’s QA suites or approved test fixtures.
