# W5-02C Payment Integration Boundary — Design Contract

## Recommended source of truth

**PaymentIntent** is the authoritative payment lifecycle record for W5-02 reconciliation:
- `TopUpRequest` remains the W5-01 customer-facing top-up request record (PENDING).
- `PaymentIntent` is the W5-02 payment lifecycle record (PENDING/SUCCEEDED/FAILED/REJECTED/EXPIRED).
- `WalletEntry` remains the W5-01 immutable ledger entry.
- `PaymentAttempt` and `PaymentProviderEvent` preserve provider evidence.

There is currently **no relationship** between `TopUpRequest` and `PaymentIntent`. The boundary must create a `PaymentIntent` from an authorized `TopUpRequest`, then reconcile it through the existing synthetic `TopUpReconciliation` service.

## Existing files to reuse

- `apps/api/src/billing/billing.store.ts` — `BILLING_STORE`, `BillingStore.requestTopUp`, immutable `walletEntry` reads.
- `apps/api/src/billing/prisma-billing.store.ts` — transactional idempotent top-up request creation.
- `apps/api/src/billing/billing.service.ts` — `requestTopUp`, `wallet`, `transactions`.
- `apps/api/src/payments/payment-intents.store.ts` — `PaymentIntentStore.createPending`, idempotent by `(organizationId, idempotencyKey)`.
- `apps/api/src/payments/payment-intents.service.ts` — intent creation validation.
- `apps/api/src/payments/payment-intents.tokens.ts` — `PAYMENT_INTENT_STORE`.
- `apps/api/src/payments/top-up-reconciliation.ts` — synthetic reconciliation service.
- `apps/api/src/payments/top-up-reconciliation.spec.ts` — 11 passing reconciliation tests.
- `apps/api/src/payments/payment-provider.contracts.ts` — `SYNTHETIC_PROVIDER` / `SYNTHETIC_ENVIRONMENT`.
- `packages/database/prisma/schema.prisma` — existing `TopUpRequest`, `PaymentIntent`, `PaymentAttempt`, `WalletEntry`, `PaymentProviderEvent`.

## Exact integration sequence

1. Customer requests a W5-01 top-up through `BillingService.requestTopUp`. Record `TopUpRequest` is PENDING with idempotency key.
2. W5-02 orchestration service creates a `PaymentIntent` with `purpose='WALLET_TOP_UP'`, same `organizationId`, `amountMinor`, `currency='UGX'`, and same idempotency key.
3. The intent creation returns the `providerReference` used by reconciliation.
4. Synthetic settlement events are reconciled through `TopUpReconciliation.receive(callback)` or `reconcile(eventId)`.
5. Reconciliation validates signature, matches intent by provider reference, matches amount/currency/org, then atomically inserts `PaymentAttempt`, `WalletEntry` (exactly-once via unique `(organization_id, payment_intent_id)`), and updates intent status to `SUCCEEDED`.
6. Customer-visible top-up status is derived from the linked payment intent status.

## Shared files requiring coordinated changes

None may be modified without owner coordination. New W5-02-owned files can depend on existing shared contracts read-only.

## New files implemented (recommended, isolated W5-02-owned)

- `apps/api/src/payments/top-up-integration.store.ts` — read-only store view linking `TopUpRequest` to `PaymentIntent` by organization + amount + idempotency key; no shared-file writes.
- `apps/api/src/payments/top-up-integration.service.ts` — provider-neutral orchestration:
  - `createPaymentIntentFromTopUp(topUpRequest)` returns intent or existing intent.
  - `reconcileTopUp(callback)` delegates to `TopUpReconciliation`.
  - `topUpStatus(topUpRequestId)` returns PENDING/SUCCEEDED/FAILED/REJECTED/EXPIRED.
- `apps/api/src/payments/top-up-integration.spec.ts` — mock store and reconciliation tests for mapping, idempotency, mismatches, cross-tenant isolation, duplicate reconciliation.

## Whether a migration is necessary

No migration is necessary for the contract layer if new files only read existing tables via Prisma. A migration may be required later only if a foreign-key/link table between `TopUpRequest` and `PaymentIntent` is needed for production traceability. **Do not apply any migration in this phase.**

## Exact approvals required

1. Integration boundary ownership (who may write new W5-02 files vs shared billing/payment files).
2. Local-test database name and isolation rules for payment integration tests.
3. Nest module/HTTP wiring approval before any synthetic payment endpoint is registered.
4. Owner approval to expose a local-only browser simulation UI.

## Recommended implementation owner

The agent owning W5-02 payment integration, after coordination with billing and payment module owners.

## W5-02C status

READY FOR DESIGN IMPLEMENTATION. No real payments, production wallet credits, main database writes, migrations, public callback endpoints, or deployments were performed. Existing shared files were inspected read-only only.