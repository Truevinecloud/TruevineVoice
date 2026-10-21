# @truevine/telephony

The telephony abstraction and its provider adapters. The rest of the system
places and observes calls only through the `VoicePort` declared here.

**Status: the port and a deterministic fake adapter are implemented. Africa's
Talking is explicitly not implemented yet.**

## Shape

```
telephony/
  src/
    voice.port.ts             <- VoicePort: initiateCall, hangUp, fetchCallStatus
    adapters/
      fake/                   <- deterministic, in-memory, no network
      africas-talking/        <- NOT IMPLEMENTED; provider SDK usage would live here, and only here
```

## The port

- `VoicePort.initiateCall` and `VoicePort.hangUp` accept a mandatory
  `IdempotencyKey` (branded in `@truevine/domain`), so a money-affecting
  operation cannot be issued without one. The interface does **not** itself
  prevent duplicates: durable duplicate prevention is a later
  persistence/worker concern.
- Request and result shapes are ours. Provider field names never appear here;
  an adapter maps the provider's response onto these types explicitly.
- `TelephonyError` carries a stable `kind` and a `retryable` flag; the provider's
  own message is opaque diagnostic text and must never drive control flow.
- `import type` is used for domain types so this package adds no runtime
  dependency on `@truevine/domain`.

## The fake adapter

`FakeVoiceAdapter` is deterministic and makes no network call. It is the
reference implementation of the port's idempotency contract: initiating twice
with the same key replays the original result (`replayed: true`) and places only
one call. It is safe to use anywhere a provider must be faked.

## Rules

- `@truevine/domain` and `@truevine/pricing` must **never** import this
  package's provider code. They depend on interfaces only.
- Provider SDK usage lives under `src/adapters/<provider>/` and nowhere else.
- Provider webhooks are untrusted input: validate, verify the signature,
  deduplicate and record every event before acting on it.
- Provider credentials come from the environment and are never committed.
