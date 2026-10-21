# Recipient/call persistence development progress � 2026-10-21

Canonical workplan task ID: **UNVERIFIED**.

## Base and isolation

Fresh branch feat/recipient-call-durable-idempotency was created from freshly
fetched origin/main at da2e8774544fca5eba88e50664694be01dfc11a6.
Worktree: C:/Users/User/AppData/Local/Temp/truevine-recipient-durable.
The original RBAC-004 checkout remains at 2fed7d4 with its 41 status entries.
No stash, reset, checkout, rebase, production data, infrastructure or backup
configuration mutation was performed.

PR #41 status: implementation COMPLETE; PR MERGED; CI PASSED per accepted
decision; production deployment NOT YET PERFORMED; live integration NOT
IMPLEMENTED. Its accepted foundation is not authorization to deploy.

## Scope delivered

Six tenant-scoped tables: contacts, campaign_recipients, campaign_executions,
call_attempts, call_operations and call_events. SQL was generated against the
accepted base schema, inspected, and extended with explicit checks and triggers.
The additive migration is not production-approved and the reviewed migration
allowlist is unchanged. See ADR 0018 for locking, fingerprint v1, execution
identity and redial policy. There are no customer routes or live side effects.

## Verification and command record

Commands below are in execution order; repeated inspection commands are grouped.
PowerShell file-write commands created only the files listed by the PR diff.

1. Read README, AGENTS, schema, relevant tests, ADRs and package/workflow scripts.
2. git status --porcelain; git remote -v; git fetch origin main:
   first fetch blocked by sandbox Git metadata permission; elevated retry passed.
3. git rev-parse origin/main; git merge-base --is-ancestor da2e877 origin/main:
   base confirmed; git worktree add created the clean feature branch.
4. node --version / npm.cmd --version: local Node 24.20.0 / npm 11.19.0,
   within declared engine ranges; CI uses repository pins. npm.ps1 was blocked
   by machine execution policy; npm.cmd is the supported Windows entrypoint.
5. npm.cmd ci --no-audit: passed. Existing ESLint peer-range warnings observed;
   no automatic remediation or version upgrades.
6. npm.cmd run prisma:generate; npm.cmd run prisma:validate: passed.
7. npm.cmd install --package-lock-only --ignore-scripts --no-audit: passed.
   Lockfile diff limited to the new internal @truevine/domain dependency;
   it reuses the existing validation/state vocabulary, adding no external package.
8. npm.cmd run build:packages; API typecheck: passed.
9. npm.cmd run prisma:migrate:diff -- --from-schema node_modules/.cache/baseline.prisma
   --to-schema packages/database/prisma/schema.prisma --script --output
   packages/database/prisma/migrations/20261021120000_call_persistence/migration.sql:
   passed; custom SQL checks/triggers added and reviewed.
10. Temporary edit scripts encountered quoting errors; corrected, with no
    suppressions. Targeted API typecheck, root lint and five new unit tests passed.
11. Prettier scoped to new files; git diff --check passed. Unrelated manifest
    formatting was removed from the diff.
12. Root npm.cmd run lint and npm.cmd run typecheck: passed.
13. npm.cmd test: passed all workspace tests and static deployment tests.
    Existing Windows/POSIX exclusions remain: three infrastructure cases and
    db-verify/backup runtime harnesses do not execute on Windows. No new skips.
14. npm.cmd run test:call-persistence:e2e: failed locally in setup because
    DATABASE_URL is absent; no local PostgreSQL listener or usable Docker/WSL
    runtime was found. No test was weakened or silently skipped.
15. npm.cmd run build: passed for packages, API, worker, web and admin.
16. Opened PR #42 at a8ad666. Initial Actions lint/typecheck/Prisma, unit,
    production build, migration rehearsal, restore and billing/campaign matrix
    checks passed. Disposable PostgreSQL applied the new migration successfully;
    11 of 13 new contracts passed. Two failures exposed JSONB property ordering
    during serialized replay and an invalid draft-campaign emergency-stop fixture.
17. Reconstructed replay response fields in original order (unchanged strict
    serialized-equality assertion). Corrected the fixture to activate then stop
    the campaign, retaining the existing database stop constraint and assertion.
    No assertion or guard was removed or relaxed. Reran local lint/typecheck/unit
    checks and pushed a follow-up commit for a full CI rerun.

Final CI/build results will be recorded in the delivery report and PR checks.

## Security and external dependencies

Tenant-leading composite keys/FKs; organization-scoped repository queries;
immutable snapshots and accepted identities; append-only event receipts;
durable unique operation keys; canonical fingerprint mismatch rejection;
business execution uniqueness and redial predecessor validation; atomic failure
rollback; safe conflict diagnostics; provider evidence isolated from billing.
Acceptance also rejects suspended tenants and emergency-stopped campaigns.

Ceiling billing is explicitly PROVISIONAL until Africa's Talking tariff and
charging increment verification. No charging is implemented. No claim of
exactly-once external dispatch is made: provider timeout reconciliation,
signature verification, dispatch recovery and stop rechecks await execution work.

The five previously documented high-severity development dependency advisories
remain under review. No dependency remediation is included.

## Deferred by authorization boundary

No provider integration, outbound calls, production queue execution, customer
contact/call endpoints, wallet deductions, production migration, deployment,
infrastructure/backup development or canonical task-ID assignment.
STOP before merge and deployment; both require explicit user approval.

## CI follow-up: expanded migration rehearsal

The corrected head passed all 13 new PostgreSQL contracts and the ordinary E2E
suites. The security harness then refused the new migration because its exact
reviewed test-migration list predates this task. Added only this reviewed
migration to that test list, retaining rejection of any unknown migration, and
added representative-schema assertions for all six tables and eleven integrity
triggers. This is existing verification maintenance; production approval lists,
infrastructure configuration and backup behavior are unchanged. Full CI rerun
required after this follow-up. Local production build previously passed.
