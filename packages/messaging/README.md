# @truevine/messaging

Reserved for the messaging abstraction (SMS, WhatsApp) and its adapters.

**Status: intentionally empty.** SMS and WhatsApp are explicitly deferred; the
first channel is outbound Voice.

Same rules as `@truevine/telephony`: provider SDKs stay inside `adapters/`, the
domain depends only on the interfaces, and every paid outbound operation
requires an idempotency key.
