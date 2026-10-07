# @truevine/pricing

Reserved for plans, rating rules and price calculation.

**Status: intentionally empty.** Billing, wallet and pricing are explicitly
deferred.

Rules for this package once it is populated:

- **Never import provider SDKs.** Africa's Talking publishes its own tariffs;
  those belong behind a `@truevine/telephony` adapter, never in pricing logic.
- **Never use floating-point numbers for money.** Amounts are integer minor
  units (or an exact decimal) plus an explicit currency code.
- Pricing must be deterministic: the same inputs always produce the same
  output, and the rules applied must be recorded so an invoice can be explained
  later.
- Rounding happens once, in one documented place.
