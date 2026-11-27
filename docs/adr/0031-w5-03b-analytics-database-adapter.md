# ADR 0031 W5-03B PostgreSQL read adapter and integration handoff

Status: Phases 1–3 implemented. W5-03B's organization-scoped read adapter and isolated synthetic PostgreSQL acceptance are unchanged. W5-03C adds the authenticated, read-only Nest API and registers `AnalyticsModule` in `AppModule` after explicit limited ownership clearance. No dashboard/call-log UI, schema change, migration, main-database write, provider call, payment, charge or deployment is included. W5-03 remains PARTIAL until the customer-facing workflow is integrated and verified through the browser.

## Context

ADR 0030 accepted a pure analytics calculation and CSV serializer but explicitly left the PostgreSQL read adapter, HTTP route and UI for later work. The workplan acceptance evidence is “Metrics reconcile with attempts/ledger”, so a report built from in-memory fixtures is not sufficient.

The existing schema already has the required append-only evidence: `call_attempts`, `call_events`, `voice_usage_quotes`, `voice_usage_events`, `voice_usage_reversals` and `wallet_entries`. Campaign and call tables enforce tenant keys and attempt sequencing in the database. Usage and wallet history are append-only and protected by triggers.

Ownership remains constrained. `package.json`, `README.md`, campaign, call, billing, schema, migration and module files have uncommitted work from other lanes. This change therefore adds only new files and records the exact shared-file work required once ownership is confirmed. The referenced MVP specification §7 is still unavailable in this repository, so this ADR does not claim compliance with it.

## Decision

### Read adapter

`apps/api/src/analytics/analytics-read-adapter.ts` supplies `PrismaAnalyticsReadAdapter`.

1. The caller passes an explicit organization ID. A future authorized service must derive it from the session via `@CurrentOrganization()` and the organization guard; it must never trust a body or query field.
2. Every query, including every `EXISTS` and `IN` subquery, is constrained by `organization_id`. Every returned row is rechecked against the requested organization and a cross-tenant campaign filter returns an empty report rather than another tenant's data.
3. All reads happen in one `RepeatableRead` transaction. Separate queries load campaigns, attempts, call events, usage events, reversals and only the wallet entries referenced by those usage records. No attempt-to-ledger join can multiply a charge.
4. Date filters are paired (`from` inclusive, `to` exclusive) and campaign filters are UUID-only and capped at 100 IDs. Unbounded filters are rejected with `INVALID_REQUEST`.
5. Money remains exact integer minor units. Provider cost is returned only as non-spend evidence (`amountMinor`, `currency`); raw provider usage JSON, callbacks and credentials are never selected.
6. A usage debit must reference an existing wallet debit with the exact charge; a reversal must reference an existing credit with the exact charge. Duplicate links, orphan records, missing ledger rows, unknown states or cross-tenant rows fail closed. Unlinked top-up credits are ignored for spend.
7. The adapter does not mutate records, open HTTP, import NestJS or depend on a provider SDK. It is independent of the accepted calculation in `analytics-metrics.ts`.

### Isolated database

`apps/api/test/helpers/w5-03-test-database.ts` pins the suite to `truevine_w503_integration_test` on loopback port `55432`. It rejects `NODE_ENV !== 'test'`, missing URLs, non-PostgreSQL protocols, remote hosts, other database names, routing query parameters and URL fragments. After connecting it rechecks `current_database()`.

The disposable database was created only in the local Docker PostgreSQL instance and migrated with the reviewed local migration chain. The main `truevine_voice` database, W5-01/W5-02 databases, `infrastructure/migrations-reviewed.json` and all schema files are untouched.

`apps/api/test/helpers/w5-03-fixtures.ts` writes only uniquely suffixed synthetic organizations, campaigns, contacts, recipients, executions, attempts, usage and wallet entries. Call and financial history remains append-only; fixtures are deliberately not deleted. No real call, provider callback, charge or payment is involved.

### CSV export safety

`analytics-csv.ts` now neutralises values beginning with spreadsheet formula characters (`=`, `+`, `-`, `@`, including after leading whitespace) by prepending a literal apostrophe before standard CSV quoting. This protects a future authenticated export without changing the deterministic header, row ordering or exact integer money representation.

## Verification performed

- `npx vitest run --config vitest.w5-03.config.mts` with the isolated `DATABASE_URL`: **11/11** tests passed after W5-03C (the original 6 adapter tests plus 5 HTTP tests over the same dedicated database).
- `npm run test --workspace @truevine/api -- analytics-http.spec.ts analytics.wiring.spec.ts analytics-csv.spec.ts analytics-metrics.spec.ts w5-03-test-database.spec.ts`: **5 files, 28 tests passed**.
- Full API unit suite: **1114 passed, 4 skipped (1 skipped file)**. The four skips are pre-existing and outside W5-03; no failing test was skipped or weakened.
- `npm run typecheck --workspace @truevine/api`: passed at final verification.
- `npm run lint --workspace @truevine/api`: passed at final verification.
- `npm run build --workspace @truevine/api`: passed.
- Targeted `npx eslint` on every W5-03C TypeScript file and `src/app.module.ts`: no findings.
- `npx prettier --check` on every new/modified W5-03C file: passed. `src/app.module.ts` was deliberately not reformatted, so the other lanes' uncommitted changes remain byte-for-byte intact.
- `git diff --check` on W5-03 paths: no whitespace errors.

Historical evidence handed off to the payment lane: the W5-03B run reported five `TS2554: Expected 2 arguments, but got 1` errors in `src/payments/top-up-integration.service.spec.ts` (lines 150, 174, 197, 214 and 233 at that time) and six failures in the same file, including `TopUpReconciliationError: top_up_reconciliation_key_required`. That lane subsequently fixed them; the final typecheck and full unit suite above were green. Those failures were never suppressed or modified by this work.

The isolated database acceptance suite covers multiple campaigns and outcomes, duplicate final call events, reversals, exact spend, strict cross-organization isolation, paired date/campaign filters, empty datasets, inconsistent duplicate ledger evidence, concurrency consistency, database guard rejection rules, and CSV totals matching report totals. The W5-03C HTTP suite additionally covers real guards, session-derived tenant scope, `reporting:read` denial, cross-tenant 403/404 behaviour, structured 409 evidence conflicts, pagination metadata and the bounded CSV attachment.

## W5-03C integration completed

Ownership was explicitly cleared for the minimal `AppModule` registration. The diff was captured and the file reread immediately before editing; the only added lines are the `AnalyticsModule` import and its entry in the `imports` array. All other agents' uncommitted imports and registrations were preserved.

Analytics-owned files now provide:

1. `AnalyticsService` with bounded filter/pagination parsing, exact `bigint` → string money mapping, full-report totals, paginated call-log slices and a 10,000-row CSV export bound.
2. `AnalyticsController` with six read-only routes:
   - `GET /organizations/:organizationId/analytics/summary`
   - `GET /organizations/:organizationId/analytics/campaigns`
   - `GET /organizations/:organizationId/analytics/campaigns/:campaignId`
   - `GET /organizations/:organizationId/analytics/calls`
   - `GET /organizations/:organizationId/analytics/campaigns/:campaignId/calls`
   - `GET /organizations/:organizationId/analytics/calls.csv`
3. `AnalyticsModule`, which binds the accepted `PrismaAnalyticsReadAdapter` through `ANALYTICS_READER` from the injected `DATABASE_CLIENT` and imports the exported auth guards. Constructor dependencies use explicit `@Inject(...)` tokens.
4. `docs/api/w5-03-analytics.md`, the frontend contract with exact paths, parameters, response shapes, pagination metadata, error codes, money units, status definitions and synthetic examples. It does not invent an answer-rate denominator or claim §7 compliance.

Remaining work is frontend-only: coordinate with the dashboard owner, then present attempts, answered/completed, failed/pending, exact spend, campaign performance, call logs, filters and a CSV download through the authenticated API client. After that integration, paired Chrome verification must cover DB-backed values, filters, campaign detail reconciliation, CSV totals, cross-organization denial, empty/error states and desktop/mobile layouts. A root `test:w503:postgres` script remains deliberately unadded because `package.json` has concurrent uncommitted changes.

## Alternatives considered

- **Wire the UI during API integration:** rejected because dashboard implementation needs a separate frontend owner and §7 is unavailable. The API was wired only after limited `AppModule` clearance was granted.
- **Join attempts directly to wallet entries:** rejected because one-to-many joins can multiply charges.
- **Use provider cost as customer spend:** rejected by ADR 0027 and ADR 0028.
- **Use total wallet balance or include top-ups:** rejected by ADR 0012 and ADR 0030.
- **Delete synthetic fixtures after tests:** rejected because call and financial tables are append-only; unique IDs keep suites independent.
- **Add a root test script now:** rejected because `package.json` is currently modified by other work.

## Consequences and blockers

- W5-03C now has a tested, authenticated HTTP contract between real PostgreSQL evidence and the accepted analytics engine, but no customer-facing dashboard or browser evidence.
- A report still fails closed on inconsistent ledger evidence; the API returns a structured `409` rather than partial metrics.
- Answer semantics remain the current-state proxy (`ANSWERED` or `COMPLETED`). Event-level answer rate needs an approved denominator from the missing §7.
- Dashboard layout, export column approval and any live reconciliation policy remain deferred until §7 and frontend ownership are available.
- The API is acceptance-ready with synthetic data only; W5-03 stays PARTIAL until the customer workflow is integrated and verified in the browser.
