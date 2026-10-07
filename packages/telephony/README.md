# @truevine/telephony

Reserved for the telephony abstraction and its provider adapters.

**Status: intentionally empty.** Africa's Talking will be the first Voice
adapter, but it is explicitly **not** implemented yet.

Shape this package will take:

```
telephony/
  src/
    voice.port.ts     <- interfaces: initiateCall, hangUp, fetchCallStatus, ...
    adapters/
      africas-talking/  <- provider SDK usage lives here, and only here
```

Rules:

- `@truevine/domain` and `@truevine/pricing` must **never** import
  `@telephony` provider code. They depend on the interfaces only.
- Every provider call that costs money must accept an idempotency key, and the
  adapter must not retry a non-idempotent call without one.
- Provider webhooks are untrusted input: validate, deduplicate and record every
  event before acting on it.
- Provider credentials come from the environment and are never committed.
