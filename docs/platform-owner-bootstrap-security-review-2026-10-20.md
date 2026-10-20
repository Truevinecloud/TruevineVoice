# Platform Owner bootstrap security review — 20 October 2026

Status: local review preparation; Linux execution evidence pending. No production
or staging connection, account creation, migration, access change or deployment
was performed. No commit, push or PR creation is authorized or performed.

Base and fetched origin/main: `b111b1c0da2b8448d67ef6d8b5b836ed7b25421d`.
Local branch: `feat/platform-owner-bootstrap-security-20261020`.
The original Desktop worktree and its unrelated changes remain untouched.

## Findings and corrections

| Finding | Assessment and disposition |
| --- | --- |
| Singleton/concurrency | Fixed-slot primary key, unique operation/user/audit constraints and serializable transaction fence competing bootstrap commands. Existing assignments are checked without a revoked filter. Immutable claims survive owner revocation. Real concurrent and revoked-owner tests pass. |
| Transaction/audit integrity | Identity, sole PLATFORM_OWNER assignment, activation hash, attributed identity audit and claim commit together. Actual audit/claim failure tests verify rollback. New identity is audit subject; metadata identifies the external operator and approval. No existing identity is modified. |
| Trigger relation shadowing | Confirmed defect fixed in a third forward migration. The original function inherited caller search_path, allowing temporary role/audit relations to shadow public tables. Set search_path to pg_catalog, public, pg_temp. Real temporary-table regression verifies rejection. The first two previously rehearsed migrations are preserved. |
| Filesystem checks | Hardened pathname check/use handling with descriptor-relative Linux /proc/self/fd operations; reject unsafe writable/foreign-owned ancestors, malformed operation IDs, special permission bits and replaced artifact inodes during cleanup. No overwrites; approval/activation require owned 0600 regular single-link files and owned 0700 leaf directories outside the repo. Linux execution of these protections is still unverified locally. |
| Database target identity | Host/port/name and current_database alone did not bind production to the intended cluster. Production approval now requires an independently obtained decimal systemIdentifier. The transaction reads pg_catalog.pg_control_system() and rejects a mismatch before writes. No permission grant is attempted; unavailable access fails closed. Actual disposable PostgreSQL tests exercise this query and mismatch handling. |
| Connection routing | Reject duplicate URL parameters as well as unknown redirection keys and non-public schema selection. Regression covers conflicting duplicate schema parameters. |
| Prisma/SQL consistency | Explicit onUpdate: Restrict now matches both restrictive foreign keys in the existing SQL. No historical migration edit is needed. |
| Approval | Explicit process opt-in, exact environment, private matching approval, expiry, references and dedicated new email are required. Production additionally requires explicit confirmation and productionAuthorized. Approval is externally verified operator evidence, not a cryptographic signature. Expiry is checked again after expensive password preparation. |
| Activation | Cryptographically random unusable initial password; random 24-hour activation token stored only as a hash in PostgreSQL. Existing locked-user reset transaction consumes it once. Real expiration/reuse tests pass. Raw activation is delivered only through the protected artifact. |
| Interrupted/uncertain execution | Artifact and directory entry are fsynced before DB work. Definite refusal/unique/serialization rollback retires the artifact; unknown commit and shutdown outcomes preserve it and fail. Regression simulates work completing followed by loss of transaction acknowledgment. Abrupt process-kill/power-loss rehearsal has not run. Reconcile by operation ID before any retry. |
| Logs | CLI errors are fixed diagnostics; database factory accepts an empty logging policy for this command. Token-redaction assertions use boolean comparisons so failed assertions do not print their expected raw token. CI receives no production secrets or activation artifacts. |

## Migration review

Ordered additions:

1. `20261020180000_platform_owner_bootstrap`: creates the new singleton table,
   indexes, restrictive existing-table foreign keys and validation/immutability
   triggers. Prerequisite identity/audit tables and shared append-only function
   precede it. No existing identity/role rows are rewritten.
2. `20261020181000_platform_owner_bootstrap_no_truncate`: adds a statement-level
   TRUNCATE guard. The first migration is not rewritten after its rehearsal.
3. `20261020182000_platform_owner_bootstrap_search_path`: changes only the new
   trigger function's resolution path; explicit pg_temp-last prevents temporary
   table shadowing. No SECURITY DEFINER or privilege grants are introduced.

Each is wrapped in BEGIN/COMMIT and is applied only to fresh owned databases in
testing. Existing production application queries do not depend on the additive
table. Foreign-key DDL can briefly lock referenced tables: production lock and
backup/restore rehearsal remain separate approval prerequisites. Runtime
permissions for the actual production role have not been probed.

Rollback is application rollback with claim/audit retained. There is no approved
destructive down migration or account deletion/reset procedure. Never disable
triggers, drop this table or restore credentials to permit a second bootstrap.
Database owners/superusers can alter DDL and remain trusted; invoker triggers do
not defend against that authority. All three migrations remain absent from
`infrastructure/migrations-reviewed.json`, intentionally blocking deployment.

## Validation and command record

Commands were run from the isolated checkout unless stated otherwise. Repeated
checks followed source/test changes; local logs are excluded from PR scope.

1. Read README, AGENTS, bootstrap code/declarations/tests, schema/migrations,
   activation service, audit registry, ADRs 0009/0010/0014, runbook and CI.
   Read-only git status/diff/remote checks preserved unrelated work.
2. `wsl --list --quiet`: sandbox access denied; authorized retry succeeded with
   no installed distributions. Docker/Podman/QEMU were unavailable.
3. `git fetch origin main`: PASS; current main equals the base above.
4. Initial `npm` PowerShell invocation: blocked by execution policy; used
   `npm.cmd` thereafter without changing policy.
5. `npm.cmd run lint`: initial failure from a prior generated cleanup helper in
   ignored logs/. Preserved that helper outside the checkout; subsequent lint
   passed. A concurrent log-file collision was corrected using separate final
   log paths; it was not treated as a successful check.
6. `npm.cmd run typecheck`, `npm.cmd run prisma:validate`: PASS.
7. `npm.cmd test`: PASS, 749 unit tests; three pre-existing Windows skips.
   Existing db-verify/backup POSIX runtime wrappers also report Windows skips.
   No tests were deleted, disabled or weakened.
8. `npm.cmd run build`: PASS for packages/API/worker/web/admin.
9. `git switch -c feat/platform-owner-bootstrap-security-20261020`: PASS; no
   commit or publication. Original worktree remains unchanged.
10. Private temporary helper invoked root
    `npm.cmd run test:platform-owner-bootstrap:e2e` against freshly initialized
    PostgreSQL 18 clusters. Initial sandbox startup failed, authorized retry
    passed. Intermediate runs passed 10 then 11 scenarios; test databases were
    removed and each cluster stopped. Final results are recorded below.
11. `npm.cmd run test:platform-owner-bootstrap:linux`: expected nonzero refusal
    on Windows. This is NOT a Linux pass.
12. `npm.cmd run test:platform-owner-bootstrap:unit`: PASS, 39 bootstrap tests.
13. Final lint/typecheck/Prisma checks and `git diff --check`: PASS.

Final PostgreSQL result: PASS, 12 scenarios on fresh disposable PostgreSQL 18.
The Linux CLI case executes its explicit Windows refusal branch here; its Linux
success branch is not claimed as tested. The final run left zero generated test
databases and the cluster shut down successfully. Migrations were applied only
to databases created by the test invocation.

14. Targeted `npm.cmd exec -- prettier --write` on the five new bootstrap
    command/declaration/test/runner files: PASS. Post-format lint and 39 focused
    bootstrap unit tests: PASS. No unrelated files were formatted.
15. `git add -- <the explicit 22-file list below>` and cached diff/whitespace
    checks prepare the local review index only. The old local-results document
    remains untracked and excluded. No commit, push or PR is created.

## Linux CI and PR boundary

Existing Ubuntu Actions has disposable loopback Compose PostgreSQL/Redis, pinned
actions and read-only checkout credentials. A new explicit Linux gate invokes
focused unit/filesystem tests and disposable PostgreSQL E2E, including the actual
CLI/private-file handoff. It fails on unsupported platforms. Migrations run only
inside those disposable databases; no production/staging credentials or secrets
are referenced. No new action/dependency is introduced.

These uncommitted changes cannot be tested by hosted Actions without publishing
them. Commit/push/PR authorization has explicitly been withheld; no workflow was
dispatched. Linux permissions, symlink/replacement tests and full CLI success
remain NOT TESTED until that authorized CI run passes. Windows E2E verifies
unsupported-platform refusal instead of claiming Linux CLI success.

Focused scope: bootstrap command/types, schema and three additive migrations,
audit action and quiet database-client option, security unit/E2E tests, explicit
Linux CI coverage, root npm scripts, README/ADR/operator documentation and this
review. Exclude the prior local-results document, ignored logs, temporary
PostgreSQL installation/clusters, credentials and generated output.

Ready for draft code review after publication authorization; **not ready for
security sign-off or release** until Linux evidence is green. Separate production
authorizations are still required for migration review/manifest approval,
deployment and execution naming exact release/environment/cluster/new identity/
operation/operator/approval. No internal HTTPS access, real accounts, recovery
flow or backup-restoration feature is implemented by this change.

## Files in the proposed PR

- `.github/workflows/ci.yml`
- `README.md`
- `package.json`
- `apps/api/test/platform-owner-bootstrap.e2e-spec.ts`
- `packages/auth/src/audit.ts`
- `packages/database/src/index.ts`
- `packages/database/prisma/schema.prisma`
- `packages/database/prisma/migrations/20261020180000_platform_owner_bootstrap/migration.sql`
- `packages/database/prisma/migrations/20261020181000_platform_owner_bootstrap_no_truncate/migration.sql`
- `packages/database/prisma/migrations/20261020182000_platform_owner_bootstrap_search_path/migration.sql`
- `infrastructure/scripts/bootstrap-platform-owner.mjs`
- `infrastructure/scripts/bootstrap-platform-owner.d.mts`
- `infrastructure/scripts/bootstrap-platform-owner.spec.ts`
- `infrastructure/scripts/run-platform-owner-bootstrap-linux.mjs`
- `infrastructure/scripts/run-security-tests.mjs`
- `infrastructure/scripts/README.md`
- `docs/adr/0014-first-platform-owner-bootstrap.md`
- `docs/adr/README.md`
- `docs/runbooks/platform-owner-bootstrap.md`
- `docs/runbooks/uat-account-provisioning.md`
- `docs/runbooks/README.md`
- `docs/platform-owner-bootstrap-security-review-2026-10-20.md`

Remaining trust limits: root/same-UID processes can read protected files; database
owners can bypass DDL protections; physical database clones share a system
identifier. External approval, trusted routing, approved private internal HTTPS,
restore verification and operational reconciliation remain required. Do not grant
database rights to work around a failed fingerprint read.
