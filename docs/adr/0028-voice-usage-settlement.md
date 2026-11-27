# ADR 0028 Voice usage settlement

Status: W5-01 implementation complete in code and isolated tests. Migration is additive and unapproved for production. Public provider callback ingress remains disabled.

## Context

The wallet already has an append-only UGX ledger (ADR 0012) and platform adjustments use advisory locks with durable references (ADR 0025). Callback receipts provide durable dedupe and exact dispatch-owned source/session bindings (ADR 0027). None of those primitives create a customer charge from call usage.

There is no approved Africa’s Talking tariff or charging increment. The provider’s raw `amount` is untrusted evidence, and `computeBillableUsage()` in `@truevine/domain` remains provisional. We must therefore prove duplicate-callback safety without inventing a price or accepting a provider number as money.

## Decision

Rating and settlement are separate, internal-only operations.

1. A trusted caller supplies an exact integer quote through `UsageSettlement.quote()`: organization, attempt, callback source/session binding, billed seconds, rate per second, customer charge, optional provider cost evidence, and an explicit pricing version. The charge must equal `rate * billedSeconds`; no float, provider amount, JSON number, or HTTP payload can reach this boundary. The row is immutable and is stored before any wallet mutation.
2. `CallbackReceipts.process()` optionally invokes `UsageSettlement.settle()` inside the same receipt transaction. Settlement uses only the binding-derived organization/attempt identity and the receipt’s own event key. Receipt completion, usage evidence and the wallet debit commit together; any failure rolls all of them back and the durable receipt remains retryable. The settlement outcome is recorded on the receipt, so a refused charge is visible rather than silently reported as an ordinary call application.
3. Only a `COMPLETED` callback state is billable. Every other callback state is explicitly unbillable and produces no ledger entry, even if a quote exists.
4. Idempotency is enforced in PostgreSQL:
   - wallet reference `voice-usage:<organization>:<event key>` is unique per tenant;
   - usage events are unique by `(organization_id, receipt_event_key)` and by `(source, receipt_event_key)`;
   - one quote can fund at most one usage event;
   - advisory locks serialize the same debit key and the same organization/currency balance check.
   Replaying an exact receipt, replaying with a different event key, and concurrent processing of the same receipt therefore cannot create a second charge.
5. Provider cost is stored beside the customer charge for reconciliation, but it never changes the debit. The two fields are separately constrained and never conflated.
6. Insufficient balance is a refused settlement with no ledger write and no usage event. It does not silently overdraw the wallet.
7. A correction is a new compensating credit plus an immutable reversal reason. The original debit and usage event are never updated or deleted; append-only triggers reject both. Reversing twice is an idempotent no-op.

The new `voice_usage_quotes`, `voice_usage_events` and `voice_usage_reversals` tables are tenant-owned and organization-scoped. Their foreign keys bind every row to an existing organization and to the exact dispatch-owned callback binding. No query may infer a tenant from a callback body.

## Alternatives considered

- **Charge from provider `amount`:** rejected. It is untrusted evidence, may be in a different currency, and has no verified relationship to our customer price.
- **Use a generated UUID as the debit key:** rejected. A retry would generate a new key and double-charge.
- **Keep dedupe only in the callback receipt table:** rejected. It proves a callback was applied once, not that the ledger was touched once, and it cannot protect an internal worker retry or a second callback key for the same call.
- **Update or delete a mistaken ledger row:** rejected by ADR 0012; corrections must be compensating entries.

## Consequences

- W5-01 now has an executable duplicate-charge proof, but no production charge can occur: no approved tariff exists, no HTTP route reaches the quote API, and the public provider callback module remains unmounted.
- The migration `20261123120000_usage_settlement_w5_01` is deliberately not listed in `infrastructure/migrations-reviewed.json`. Human review and separate database-owner approval are still required before any deployment.
- A future approved pricing change must supply a new explicit `pricingVersion`; it must not rewrite historical quotes or usage events.
- The worker is the only application wiring point. API callbacks remain synthetic/internal, and W4-03B controls are unchanged.
