# @truevine/domain

Reserved for the pure business domain: entities, value objects, invariants,
state machines and domain errors.

**Status: intentionally empty.** The domain model is designed deliberately in a
later task so that tenancy, money handling and idempotency are agreed before any
code is written.

Hard rules for this package once it is populated:

- **Never import provider SDKs.** Africa's Talking, payment providers and any
  other external service is reached only through an interface declared in this
  package or in `@truevine/telephony`, and implemented in an adapter.
- **Never import from `apps/*`.** Packages depend on packages, never the other
  way round.
- **Never perform I/O.** This package holds rules; application services in
  `apps/api` orchestrate persistence and providers.
- Every multi-tenant entity carries an `organizationId`, and cross-tenant access
  is impossible to express rather than merely discouraged.
- Money is never a JavaScript floating-point number. Represent amounts as
  integer minor units (or an exact decimal type) with an explicit currency, and
  keep rounding rules in the domain, not at the edges.
