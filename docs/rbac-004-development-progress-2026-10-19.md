# RBAC-004 ? Customer Billing ? 19 October 2026

Branch: `feat/rbac-004-customer-billing`. Uncommitted implementation; no publication,
production access, migration approval, database migration, merge or deployment.
The pre-existing RBAC-003 report remains unchanged.

## Assessment

**PARTIAL / not production-ready.** Customer billing UI, tenant-scoped backend,
permission checks, ledger schema and pending top-up requests are implemented.
Actual payment collection/settlement is blocked on provider selection. Real
PostgreSQL E2E and browser UAT remain unverified locally.

## Completed

- OWNER/BILLING can view wallet balance and paginated ledger history, save billing
  name/email/address and submit pending top-up requests. Other organization roles
  are refused; every request rechecks session, terms, membership and permissions.
- Billing-only users cannot activate campaigns through the actual status route.
  No contact permission is granted. Contacts remain unimplemented; the unknown
  route's 404 is not claimed as a future permission enforcement mechanism.
- UGX amounts use bigint and decimal JSON strings. Balance is the sum of ledger
  entries. SQL triggers prohibit ledger/request update, delete and truncate;
  composite tenant keys, foreign keys and unique references support isolation and
  replay safety. No customer credit/debit endpoint is exposed.
- Pending requests are durably idempotent by tenant/key. Different payload replays
  return 409. The browser persists request identity across ambiguous failures and
  refreshes; requests do not collect money or change the wallet balance.
- Server-rendered billing page forwards the session uncached, refuses unauthorized
  tenant selection and shows load failures instead of false zero balances. Forms
  use the existing CSRF-aware proxy client. README and ADR 0012 document limitations.
- Added real PostgreSQL E2E coverage for sign-in/terms, billing/profile/history,
  concurrent replay, foreign cursors, campaign denial and ledger constraints. It
  requires disposable loopback infrastructure and does not apply migrations itself.

## Commands and verification, in order

1. `git status`, `rg`, `Get-Content`: inspected README/AGENTS, existing
   controllers, stores, guards, tests, Next.js local documentation and ADRs.
2. `npm.cmd run prisma:generate`, `npm.cmd run prisma:validate`: PASS; local
   client generation/schema validation only, no database migration.
3. `npm.cmd run typecheck`: PASS; repeated after adding the new test sources.
4. Initial `npm.cmd run lint`: failed on an unnecessary regex escape in a new
   frontend test. Corrected the expression without changing its assertions.
5. Final `npm.cmd run lint`: PASS.
6. `npm.cmd test`: **643 passed, three existing Windows skips** (34 added tests).
   Includes real HTTP/guards/service with fake persistence, frontend render checks,
   exact integer money and browser retry tests. Linux-only backup/restore wrappers
   retain their existing Windows skips. These are not real PostgreSQL/browser UAT.
7. `npm.cmd run build`: PASS for packages and API, worker, web and admin. Web build
   includes `/app/billing`.
8. `Get-Command docker, psql, pg_ctl`: none available. A loopback-only TCP check
   found configured PostgreSQL unavailable; no production connection attempted.
9. `npm.cmd run test:billing:e2e`: **FAILED prerequisite**, exit 1: an explicitly
   disposable loopback test database was not configured. Its three tests did not
   run. No skip or weakened assertion was added to hide this failure.
10. `git switch -c feat/rbac-004-customer-billing`: isolated the pending changes.
11. Selective formatting, `git diff --check`, scope/hash checks: reviewed final
    changes; existing migration approvals and the prior report preserved.

## Remaining gaps / next steps

- Select provider, sandbox credentials and settlement contract before implementing
  paid top-ups. A customer request must never be treated as payment confirmation.
  Verified settlement and financial reconciliation remain a separate required step.
- Invoices, tax calculation, usage charging, multi-currency and provider webhooks
  are not implemented or claimed complete.
- Run `npm run test:billing:e2e` against an explicitly disposable loopback test
  database with the new migration applied, `NODE_ENV=test` and
  `BILLING_E2E_DISPOSABLE=1` (or existing disposable GitHub CI). Review SQL against
  live PostgreSQL before approval, then perform browser UAT. No local Docker
  installation or production substitute was attempted.
- The new migration `20261019160000_customer_billing_rbac_004` is deliberately
  **unapproved**; `infrastructure/migrations-reviewed.json` remains unchanged.
  No new dependency or production configuration was introduced.

## Files created or changed for RBAC-004

- `README.md`
- `apps/api/src/app.module.ts`
- `apps/api/src/billing/billing.controller.ts`
- `apps/api/src/billing/billing.module.ts`
- `apps/api/src/billing/billing.service.spec.ts`
- `apps/api/src/billing/billing.service.ts`
- `apps/api/src/billing/billing.store.ts`
- `apps/api/src/billing/prisma-billing.store.ts`
- `apps/api/test/billing.e2e-spec.ts`
- `apps/api/test/billing.http.spec.ts`
- `apps/api/test/fakes/billing.fakes.ts`
- `apps/web/src/app/app/billing/BillingForms.tsx`
- `apps/web/src/app/app/billing/BillingView.tsx`
- `apps/web/src/app/app/billing/billing.spec.tsx`
- `apps/web/src/app/app/billing/page.tsx`
- `apps/web/src/app/app/layout.tsx`
- `apps/web/src/app/app/page.tsx`
- `apps/web/src/lib/billing-api.ts`
- `apps/web/src/lib/billing.ts`
- `apps/web/src/lib/top-up-request.spec.ts`
- `apps/web/src/lib/top-up-request.ts`
- `docs/adr/0012-customer-billing-ledger.md`
- `docs/adr/README.md`
- `docs/rbac-004-development-progress-2026-10-19.md`
- `package.json`
- `packages/database/prisma/migrations/20261019160000_customer_billing_rbac_004/migration.sql`
- `packages/database/prisma/schema.prisma`
