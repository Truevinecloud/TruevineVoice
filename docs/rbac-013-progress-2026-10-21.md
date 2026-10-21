# RBAC-013 backend delivery and verification

Date: 2026-10-21. Workplan status: In Progress, awaiting implementation review.
PR: https://github.com/Truevinecloud/TruevineVoice/pull/45.
Base: 5b5f1b00f4d18af3d9d890ebf6577d7b47317430.

The [assessment and coverage matrix](rbac-013-sensitive-action-audit.md) records
the original gaps, supported mutations, future integration requirements and SQL
review. [ADR 0020](adr/0020-sensitive-action-audit.md) remains proposed for review.
Backend files only were changed; existing frontend workspaces were tested/built.

## Files created or changed

- README.md
- apps/api/src/auth/audit-context.spec.ts
- apps/api/src/auth/audit-context.ts
- apps/api/src/auth/audit-writer.spec.ts
- apps/api/src/auth/auth.module.ts
- apps/api/src/auth/auth.service.ts
- apps/api/src/auth/auth.store.ts
- apps/api/src/auth/organization.guard.ts
- apps/api/src/auth/prisma-stores.ts
- apps/api/src/auth/sensitive-audit.ts
- apps/api/src/auth/tenant-write.ts
- apps/api/src/billing/prisma-billing.store.ts
- apps/api/src/campaigns/campaigns.service.spec.ts
- apps/api/src/campaigns/campaigns.service.ts
- apps/api/src/campaigns/prisma-campaign.store.spec.ts
- apps/api/src/campaigns/prisma-campaign.store.ts
- apps/api/src/operations/operations.controller.ts
- apps/api/src/operations/operations.service.ts
- apps/api/src/operations/operations.store.ts
- apps/api/src/operations/prisma-operations.store.spec.ts
- apps/api/src/operations/prisma-operations.store.ts
- apps/api/src/organizations/organizations.controller.ts
- apps/api/src/organizations/organizations.service.ts
- apps/api/test/fakes/auth.fakes.ts
- apps/api/test/operations.e2e-spec.ts
- apps/api/test/sensitive-audit.e2e-spec.ts
- docs/adr/0020-sensitive-action-audit.md
- docs/adr/README.md
- docs/rbac-013-sensitive-action-audit.md
- infrastructure/scripts/bootstrap-platform-owner.mjs
- infrastructure/scripts/provision-operations-admin-uat.mjs
- infrastructure/scripts/provision-owner.mjs
- infrastructure/scripts/run-security-tests.mjs
- package.json
- packages/auth/src/audit.ts
- packages/auth/src/errors.ts
- packages/auth/src/index.ts
- packages/auth/src/sensitive-audit.spec.ts
- packages/auth/src/sensitive-audit.ts
- packages/database/prisma/migrations/20261021150000_sensitive_audit_integrity/migration.sql
- docs/rbac-013-progress-2026-10-21.md (this delivery record)

## Commands executed and outcomes

Primary commands, in execution order; repeated reads and log polling are grouped.

1. Read README.md, AGENTS.md, existing ADRs, Prisma migrations, auth/membership,
   RBAC-012, API repositories, audit consumers, operator scripts and tests.
   Inspected Git worktrees and origin/main; created this isolated feature worktree
   from the verified baseline. Original RBAC-004 worktree was not modified.
2. npm ci: dependency installation completed with existing peer/advisory warnings,
   but this Windows environment omitted all 15 workspace junctions. Initial
   typecheck/test module-resolution failures identified that environment problem.
3. npm install --workspaces --include-workspace-root --ignore-scripts --offline
   --no-save --package-lock=false: failed ENOTCACHED. Restored only the 15 expected
   local workspace junctions from committed package-lock link entries, verifying
   their resolved targets stay inside this isolated worktree. No dependency,
   lockfile or compiler configuration changes.
4. npm run prisma:generate: passed.
5. npm run prisma:validate: passed.
6. npm run typecheck: passed after environment repair and development fixes.
7. npm run lint: passed.
8. npm test: passed, 787 workspace unit tests; deployment static checks 222 passed,
   with 3 existing Windows-specific skips. Existing POSIX recovery runtime scripts
   do not run on Windows; hosted Linux CI exercises those checks.
9. npm run build: passed for packages and all four applications.
10. git diff --check: passed. Production migration approval and package-lock.json
    are unchanged relative to the verified baseline.
11. git commit; git push; gh pr create: implementation dac11c18f2a22639040e0ccd1e2c2f93557e0c16
    published as PR #45. First push hit transient DNS failure; retry succeeded.
12. gh run view --log-failed: first hosted E2E found a malformed closing dollar
    quote in the test-only failure trigger and an old emergency audit assertion.
    Corrected the test SQL and expanded the existing assertion to check the entire
    new contract (no assertions deleted or skipped). All other existing API tests,
    including the 33 RBAC-012 tenant-isolation tests, passed in that first run.
13. npm run typecheck; npm run lint; git diff --check: passed after test corrections.
    Committed/pushed f72cdc12dfac5a894d380181ed48c2feea537d07 for a full fresh CI run.
14. Hosted disposable PostgreSQL and security verification: passed, results below.
15. Read-only original-worktree status: still 41 uncommitted entries. An initial
    sandbox identity ownership refusal was resolved by reading as the authorized
    user; no safe.directory or original-worktree configuration changes.

No local PostgreSQL/Redis/Docker environment was available. Local E2E success is
not claimed. Required real PostgreSQL results come from existing disposable
GitHub CI infrastructure; no production database was used.

## Hosted verification

Implementation head f72cdc12dfac5a894d380181ed48c2feea537d07 passed all nine
PR checks. This evidence-only follow-up must also pass CI at its final PR head.

- [Main CI](https://github.com/Truevinecloud/TruevineVoice/actions/runs/39656759765):
  lint/typecheck/Prisma, unit tests, E2E and production builds all passed.
- Ordinary disposable PostgreSQL E2E: API 206/206, queue 5/5, database 33/33.
- Separately created security databases: API 206/206, queue 5/5, database 33/33.
  Each API run includes all 28 new sensitive-audit tests and all 33 RBAC-012
  tenant-isolation regression tests; no skipped API tests.
- Linux Platform Owner bootstrap: 39 unit checks plus 12 PostgreSQL E2E tests passed.
- [Isolated RBAC database CI](https://github.com/Truevinecloud/TruevineVoice/actions/runs/39656759674):
  workflow checks, billing and campaign database E2E passed.
- [Migration rehearsal](https://github.com/Truevinecloud/TruevineVoice/actions/runs/39656759621): passed.
- [Restore integration](https://github.com/Truevinecloud/TruevineVoice/actions/runs/39656759644): passed.
- PR remained OPEN with automatic merge disabled. No task-complete claim: human
  implementation review and production migration approval remain outstanding.

## Migration and security controls

20261021150000_sensitive_audit_integrity adds only BEFORE TRUNCATE triggers to
the two existing audit tables; UPDATE/DELETE protection stays in place. Exact
SQL checksum, table-lock considerations, backward compatibility and rollback
limits are in the assessment. The migration applied only in disposable CI.
Production approval manifest remains unchanged and this migration is unapproved.

Required audit writes share supported sensitive mutation transactions; insertion
failure aborts the mutation. Fresh membership/platform checks and organization
locks preserve tenant isolation and make concurrent before/after chains truthful.
The new suite tests real PostgreSQL audit insertion failure for 11 mutation paths,
replay/concurrency, permissions, platform exceptions, privacy and tamper attempts.
No financial balance-changing feature was activated.

## Remaining risks, warnings and deferred work

- No merge, production approval, deployment or production data change occurred.
  PR review and all production migration/release gates remain required.
- Ordinary application writes cannot update/delete/truncate audit history.
  Database owners/superusers can change DDL; absolute immutability is not claimed.
  Production least-privilege and retention/erasure governance remain operator work.
- Failed/denied attempts are best effort after rollback. An unavailable audit
  database cannot retain that secondary event; original refusal is preserved.
- Existing clients receive explicit server purpose codes when no reason is supplied.
  Human justification is validated when supplied, not retroactively required by a
  breaking API change. Emergency reason codes remain mandatory.
- Free-text redaction catches obvious credential patterns, not arbitrary secrets;
  historical metadata is untouched. Digests reduce copied personal data but are
  neither encryption nor tamper-evident chaining.
- Bootstrap/local provisioning clearly marks OS/external operator attribution;
  a shared OS account does not prove the individual human identity.
- PostgreSQL timestamps are server transaction time, not guaranteed commit order.
- Five pre-existing high-severity development advisories and peer warnings remain
  documented, with no automatic remediation or new dependencies.
- Wallet adjustments/charging, subscription assignments, generalized administrative
  role management, account reactivation and emergency overrides do not yet exist.
  Their future writers must integrate required audits atomically. No frontend,
  real calling, infrastructure, scheduling or backup development was introduced.
