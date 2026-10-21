# ADR 0017: Provider-neutral telephony port and pure call domain

- Status: Accepted for implementation
- Date: 2026-10-21

## Context

`packages/domain` and `packages/telephony` were reserved and empty. The next
slice of the product is outbound Voice, whose first provider will be Africa's
Talking. Before any provider SDK is touched, three risks have to be closed:

1. **Provider lock-in of the domain.** If a provider's field names or status
   strings leak into business logic, swapping or adding a provider becomes a
   rewrite. The domain must depend on vocabulary we own.
2. **Money correctness.** A chargeable amount derived from a float, or from a
   provider's self-reported "billable" seconds, is a real loss or overcharge
   (`AGENTS.md` 6).
3. **Duplicate paid operations.** A retried call placement without a stable
   idempotency key is a double-charge (`AGENTS.md` 9).

A provider also delivers events more than once and out of order, including after
a call has already finished. Scattered status strings would let a late callback
resurrect a completed call.

## Decision

- **A provider-neutral port.** `@truevine/telephony` declares `VoicePort`
  (`initiateCall`, `hangUp`, `fetchCallStatus`) with request/result types we own.
  Provider SDK usage is permitted only under `src/adapters/<provider>/`, and the
  Africa's Talking adapter is deliberately **not** implemented. A deterministic
  `FakeVoiceAdapter` implements the port for tests and makes no network call.
- **A pure domain.** `@truevine/domain` owns the value objects and rules and
  imports no provider SDK. It holds:
  - `Money`: `bigint` integer minor units plus an explicit ISO 4217 currency;
    `moneyFromDecimalString` is the single decimal→minor-unit conversion and
    defines the single half-up rounding rule (`>= .5` rounds up).
  - `PhoneNumber`: validated E.164, branded so an unvalidated string cannot be a
    destination by accident.
  - An explicit call state machine: `QUEUED → DIALING → RINGING → ANSWERED →
    COMPLETED`, with `FAILED`, `BUSY`, `NO_ANSWER`, `CANCELLED` and `TIMEOUT` as
    terminal states. Duplicate and late events are idempotent **no-ops**
    (`{ changed: false }`); genuinely illegal moves throw `CallStateError`.
  - The organization-scoped `Call` entity, which keeps three things separate:
    provider-reported usage (evidence), our billable usage (derived from a
    recorded per-second rate with our own ceiling rule), and raw duration.
- **Idempotency at the type level.** Every money-affecting port method requires a
  `IdempotencyKey` branded by `parseIdempotencyKey`, which rejects empty or
  whitespace-only keys. This prevents an unvalidated key by construction. Durable
  duplicate prevention (a uniqueness constraint plus replay of the original
  result) is a **later persistence/worker concern** and is not implemented here.
- **Provider errors are mapped.** `TelephonyError` carries a stable `kind`
  (`invalid_request`, `unauthorized`, `rate_limited`, `provider_unavailable`,
  `not_found`, `unknown`) and a `retryable` flag; the provider's own message is
  opaque diagnostic text and must never drive control flow. Retries reuse the
  same idempotency key.

## Consequences

No database migration, no API/worker execution change and no external
infrastructure are introduced: this is a pure domain plus an interface and a
fake. The unit suites pin the money rounding rule, E.164 validation, the full
transition graph (legal, illegal, duplicate, terminal and late events), the
idempotency requirement, the fake adapter's replay contract, and the package
boundaries (no provider SDK in the domain, no `apps/*` imports).

Because durable duplicate prevention is deferred, the fake adapter's in-memory
key store proves the *contract* only; a real deployment still needs the unique
constraint and replay behaviour in the persistence layer before it can safely
place paid calls. Likewise, the Africa's Talking adapter, the webhook endpoint
and the callback signature verification are deferred and require their own task
and ADR. This decision places no real call and performs no financial
transaction.
