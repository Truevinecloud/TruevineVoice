# ADR 0027 Voice callback receipts and processing

Status: internal synthetic pipeline and strict provider normalization implemented. Public authentication proposal pending approval.

PostgreSQL retains minimized receipts and dispatch-owned session bindings.
Only a trusted outbound dispatcher may insert an immutable source/session to
organization/attempt binding. The composite foreign key enforces the attempt's
tenant. Receipt data supplies neither tenant nor attempt identity. For the
internal synthetic source, the versioned receipt key hashes the source, session,
requested call state and canonical event time. This is synthetic deduplication
and makes no assumption about real provider event IDs.

The optional worker uses a separately supplied VOICE_CALLBACK_DATABASE_URL.
It polls due PostgreSQL receipts every five seconds and offers IDs to BullMQ.
Redis carries IDs only. There is no published flag to strand a receipt if Redis
loses a job. The consumer locks the pending receipt, resolves its binding, and
commits call-event handling and receipt completion in one transaction using the
same state rules as CallPersistence.recordEvent. Final attempts cannot regress.
Unresolved bindings and processing failures back off exponentially, up to eight
durable attempts, then remain in PostgreSQL dead-letter state for operator
review. A binding wakes pending receipts. A database outage leaves the receipt
recoverable without a recorded attempt until PostgreSQL is reachable again.
Operational data consists of aggregate status counts and fixed error codes.

## Callback source and normalization contract

The `source` column identifies the callback namespace, not the process that
dispatched the call. Exactly three values are valid:
`africas-talking` (provider adapter), `fake` (deterministic test adapter) and
`synthetic` (loopback-only test ingress). Dispatch binds a session under one of
these namespaces; receipt processing resolves `(source, session_id)` only by
exact match. There is no session-ID-only lookup, no cross-provider fallback and
no fallback between synthetic and provider sources. Tenant and attempt identity
always come from that binding, never from a callback body.

The worker derives the binding source from the selected voice adapter. The fake
adapter remains the default; selecting the Africa's Talking adapter selects the
`africas-talking` namespace. Changing the source from a process-role value to a
provider namespace changes the durable binding identity, so existing
uncommitted local session bindings are not reusable and no migration rewrites
them.

Africa's Talking Events payloads are normalized at the adapter boundary.
Accepted documented fields are `sessionId`, `callSessionState`, `isActive`,
`direction`, `callerCountryCode`, `callerNumber`, `destinationNumber`,
`callStartTime`, `clientRequestId`, `durationInSeconds`, `currencyCode`,
`amount`, `errorMessage` and `hangupCause`. Unknown fields, malformed session
IDs, inconsistent active flags and unsupported states are rejected. Supported
state words are `Dialing`, `Ringing`, `Bridged`, `Completed`, `NotAnswered` and
`Expired`; `Active`, `Enqueued` and `Dequeued` are documented but ambiguous for
outbound call state and are rejected rather than guessed.

The documented Events sample has no event timestamp. Provider receipts record
`received_at` when the request is accepted and use the same value as
`occurred_at`; no wall-clock time is invented as provider event time. The
provider dedupe key hashes source, session, normalized state and active flag,
so exact retries collide while a changed event gets a new key. Duration, cost,
currency and error fields are retained only as bounded evidence and never
become usage, a charge or a wallet event.

## Proposed public authentication

Expose a dedicated HTTPS Events URL only after separate deployment approval.
Use a platform-generated 256-bit random callback URL token per configured
provider source. Retain its SHA-256 digest server-side. Compare digests in
constant time, support time-boxed overlap during rotation, and reject revoked,
expired or unknown tokens before accepting a receipt. A URL token is a bearer
credential and provides no cryptographic proof of provider identity or integrity.
A leaked token could permit forged events. TLS protects transport, while receipt
deduplication limits exact replay and does not authenticate changed payloads.

Suppress the full path and query in edge, application, tracing and error logs.
Apply route-specific request-size, content-type, schema and rate limits before
persisting. Accept only documented event fields and correlate through the trusted
binding. Treat old or otherwise inadmissible events according to a reviewed
retention and replay policy. Unverifiable requests fail closed. Apply provider IP
restrictions only after confirming official HTTP Events source ranges and
trusted-proxy handling. The event endpoint has no authority to place calls,
return VoiceXML instructions, charge customers or grant tenant access.

Before enabling ingress, approve the authentication model, leakage controls,
rotation, retention and residual risk. Confirm real payload and retry semantics
against official documentation or approved captured examples. Verify job recovery,
concurrent inserts, tenant correlation and terminal-state protection against
separately approved disposable PostgreSQL and Redis.
