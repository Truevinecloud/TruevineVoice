# @truevine/domain

The pure business domain: entities, value objects, invariants, state machines
and domain errors. It performs no I/O and imports no provider SDK.

**Status: populated with the first slice — money, phone numbers, call state and
the outbound call entity.**

## What is here

- `money.ts` — exact monetary values.
  - Amounts are `bigint` **integer minor units** plus an explicit ISO 4217
    currency code. A decimal `number` can never be constructed.
  - `moneyFromDecimalString` is the single conversion point from a human decimal
    into minor units, and `roundHalfUpMinor` behaviour is the single, documented
    rounding rule in the codebase (half-up: `>= .5` rounds up).
  - `add`, `subtract`, `compare` refuse to combine different currencies.
- `phone-number.ts` — E.164 validation and a branded `PhoneNumber` so an
  unvalidated string cannot be used as a destination by accident.
- `call-state.ts` — the call lifecycle as an explicit state machine:
  `QUEUED → DIALING → RINGING → ANSWERED → COMPLETED`, with `FAILED`, `BUSY`,
  `NO_ANSWER`, `CANCELLED` and `TIMEOUT` as terminal outcomes. Duplicate and
  late-arriving events are idempotent no-ops (`{ changed: false }`); genuinely
  illegal moves throw `CallStateError`.
- `call.ts` — the organization-scoped `Call` entity. It ties state to billed
  usage while keeping three things **conceptually separate**:
  - provider-reported usage (`ProviderUsage`) — evidence, never a charge;
  - our billable usage (`BillableUsage`) — derived from a recorded per-second
    rate with our own rounding rule;
  - call duration — reported seconds, not money.
  - A paid initiation requires a non-empty `IdempotencyKey`; the branded type
    makes an unvalidated key impossible to pass.

## Durable idempotency

`parseIdempotencyKey` validates the *shape* of a key only. Durable duplicate
prevention — storing the key under a uniqueness constraint and replaying the
original result — belongs to the later persistence/worker implementation, not
to this package.

## Hard rules for this package

- **Never import provider SDKs.** Africa's Talking, payment providers and any
  other external service is reached only through an interface, implemented in an
  adapter. This package must not depend on `@truevine/telephony`.
- **Never import from `apps/*`.** Packages depend on packages.
- **Never perform I/O.** Application services in `apps/api` orchestrate
  persistence and providers.
- Every multi-tenant entity carries an `organizationId`.
- Money is never a JavaScript floating-point number.

## Persistence follow-up

ADR 0018 defines internal PostgreSQL acceptance and append-only event evidence.
The ceiling rule is **PROVISIONAL** pending Africa's Talking tariff and charging
increment verification; this domain helper must not initiate real charging.
