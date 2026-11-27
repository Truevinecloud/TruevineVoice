# ADR 0029 Synthetic top-up reconciliation

Status: W5-02 synthetic-only slice implemented in new files and isolated tests. No public callback route, provider SDK, live credential, production migration, or shared module wiring is included. The approved MVP specification §17/§14 is unavailable in this repository; this ADR does not claim compliance with text that has not been read.

## Context

The W5-02 workplan row requires a mobile-money/payment integration that uses sandbox/test mode first and where a verified callback/reconciliation credits the wallet. Its acceptance criterion is “Top-up path reconciles” and it references §14 and §17 of an approved MVP workplan.

The repository contains the CSV row but no standalone approved MVP specification with those sections. `AGENTS.md` §17 is repository hygiene, not a product requirement. ADR 0012 and ADR 0024 explicitly defer payment collection, wallet crediting, webhook callbacks, signature verification and reconciliation. Those decisions have not been superseded by an approved document available here.

Existing payment persistence already has the durable primitives needed for a synthetic proof: `payment_intents`, `payment_attempts`, `payment_provider_events`, and a `wallet_entries.payment_intent_id` column with a unique one-credit-per-intent index. No migration is required.

Ownership was also constrained: Kilo Code owns payment E2E and migration-approval worktrees, and shared billing/payment/module files have concurrent uncommitted work. This change therefore stays in a new-files-only lane.

## Decision

Implement an unwired, synthetic-only reconciliation service and prove its contract with isolated tests. Do not activate a real provider or claim the full W5-02 acceptance criterion.

1. `TopUpReconciliation` accepts only callbacks in the explicit `SYNTHETIC_SANDBOX`/`SANDBOX` namespace. This is a test namespace, not an MTN or Airtel adapter.
2. A callback shape is validated before any database work. Money is a positive decimal integer string of minor units with an explicit `UGX` currency. No float, provider `amount`, or JSON number is accepted. Identifier lengths are bounded so they fit the existing ledger and event columns.
3. A callback must carry a hex HMAC over a canonical payload. Verification uses a key supplied at construction, fails closed when the key is absent or too short, and uses constant-time comparison. The signature is never stored.
4. An unverified callback is recorded with `verified = false` and no wallet entry, attempt, or intent change. A verified callback is recorded before the credit in the same transaction.
5. The organization and amount come only from a trusted, uniquely resolved `payment_intents` row matched by exact `(provider, environment, provider_reference)`. Ambiguous or missing bindings return `RECONCILIATION_REQUIRED`; they never credit.
6. Reconciliation credits at most once per intent. The query uses `(organization_id, payment_intent_id)` and the existing unique index is the database-level backstop. An exact event replay returns `ALREADY_RECONCILED`; a second event for the same intent returns `RECONCILIATION_REQUIRED`.
7. A verified event, the payment attempt, the wallet credit, and the intent status commit in one transaction. Advisory locks serialize the same event and the same intent.
8. Wallet money remains exact integer minor units in the append-only UGX ledger. Corrections are out of scope for this synthetic slice and remain subject to ADR 0012.

The service is deliberately not registered in a Nest module, mounted on an HTTP route, or connected to a real provider client. Wiring it into the top-up request flow requires a separate ownership decision and an approved specification.

## Testing

- Unit tests use an in-memory fake database and cover signature verification, malformed payloads, exact amount matching, exact replay, unverified callbacks, amount mismatch, ambiguous bindings, a second event for one intent, and identifier bounds.
- A dedicated PostgreSQL suite runs only against `truevine_w502_integration_test` on loopback port 55432. Its guard is stricter than the general API E2E allowlist and refuses `truevine_voice`, main-database URLs, non-test environments, and routing query parameters. It proves the real unique index and append-only trigger behaviour with synthetic fixtures.
- No test uses a live tariff, exchange rate, provider response, real charge, or customer data.

## Alternatives considered

- **Wire a real MTN/Airtel adapter now:** rejected. ADR 0024 defers collection and there is no approved credential/callback contract or live sandbox verification.
- **Add an HTTP callback endpoint:** rejected. W4-03B callback controls are still approval-gated and shared routing files are not owned by this slice.
- **Credit from provider `amount`:** rejected. It is untrusted evidence and currency/amount policy has not been specified.
- **Reuse the shared API E2E database:** rejected. Wallet mutations require a dedicated disposable database.
- **Modify `billing.module.ts` or payment stores:** rejected. Those are shared, concurrently edited files outside the authorized lane.

## Consequences

- An isolated, synthetic “verified callback → one exact wallet credit” path is executable and testable.
- The full W5-02 acceptance criterion remains unverified end to end: no HTTP top-up path creates a bound intent, no real provider callback arrives, no signature scheme for a real provider is approved, and no reconciliation policy for failed, pending, duplicate, or mismatched live payments has been specified.
- Missing specification decisions are left blocked: approved sandbox provider(s), callback authentication contract, live amount/currency policy, reconciliation timing, terminal-state policy, and whether W5-02 supersedes ADR 0012/0024.
- No migration was added or applied to a main database. The dedicated W5-02 test database is disposable and contains only synthetic fixtures.
