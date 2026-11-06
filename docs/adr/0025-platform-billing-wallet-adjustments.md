# ADR 0025 — Platform billing wallet adjustments

Status: accepted

## Context

RBAC-008 adds platform Billing Admin wallet adjustments. Adjustments are
append-only `WalletEntry` rows, not balance edits. Each adjustment carries an
idempotency key, a mandatory reason, an actor, and a resulting ledger entry.

## Decision

Authorized platform adjustments may create negative wallet balances. A negative
balance is not a hard error because corrections, reversals, and manual
reconciliation can legitimately move a wallet below zero. The system must not
silently hide such a state.

Required controls:

- Authorization: `platform:billing:refund`, granted only to `PLATFORM_OWNER`
  and `BILLING_ADMIN`.
- CSRF protection on the mutation.
- Mandatory reason between 3 and 500 characters.
- Idempotency key required; duplicate keys replay the original entry, while
  reuse with a different amount or currency is rejected.
- Append-only ledger entry; balance remains a projection over entries.
- Reconciliation surfaces a `negative_wallet_balance` alert for every currency
  whose summed balance is below zero.
- Financial audit events are written for successful and denied adjustments.

## Consequences

- Callers can overdraw a wallet; reconciliation, not the write path, is the
  control that surfaces the resulting risk.
- No automatic blocking of negative balances is performed.