# ADR 0025 — Platform billing wallet adjustments

Status: accepted, pending product-owner approval of Option A implemented

## Context

RBAC-008 adds platform Billing Admin wallet adjustments. Adjustments are
append-only `WalletEntry` rows, not balance edits. Each adjustment carries an
idempotency key, a mandatory reason, an actor, and a resulting ledger entry.

Product-owner decision: APPROVED — Option A. Prepaid wallet balances must never
become negative through Billing Admin wallet adjustments. No overdraft or credit
facility is authorized.

## Decision

Authorized platform adjustments enforce a non-negative prepaid balance invariant.

- A positive adjustment increases the balance.
- A negative adjustment is accepted only when the resulting balance remains
  greater than or equal to zero.
- A negative adjustment that would overdraw the wallet is rejected with
  `insufficient_wallet_balance`.
- No ledger entry is written for a rejected adjustment.
- Reconciliation continues to detect historical or legacy negative balances,
  but the approved adjustment API cannot create new ones.

Concurrency controls:

- The global idempotency-key advisory lock is retained.
- A second organization-and-currency-scoped advisory lock serializes debits.
- The balance check and INSERT occur in the same transaction.
- Locks are acquired in a consistent order to avoid deadlocks.

Idempotency and audit:

- Identical-key retries replay the original committed entry without a second debit.
- Reusing a key with a different organization, amount, currency, or reason is rejected.
- Successful and denied adjustments generate financial/security audit events.
- Audit failure is not reported as a successful financial operation.

## Consequences

- Billing Admin cannot overdraw a prepaid wallet.
- Historical negative balances remain visible through reconciliation.
- No mutable wallet balance column or duplicate accounting mechanism is introduced.