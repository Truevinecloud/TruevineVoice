# W4-03 provider callback security controls — review first

Status: **review required**. Public/provider callback ingress remains disabled. Sandbox account setup and read-only credential verification may proceed; no public Events URL, VoiceXML endpoint or authoritative provider-state handling is enabled by this document.

## Why this gate exists

Africa's Talking callback guidance does not document a canonical HTTP signature, canonicalization or replay mechanism for Events POSTs. A callback therefore cannot cryptographically prove provider identity by itself. The existing receipt ADR proposes a high-entropy URL token, which is a bearer secret: it reduces accidental/malicious noise but does **not** prove the caller is the provider. Approval must explicitly accept that residual risk or require a compensating control before ingress is enabled.

Reference: `docs/adr/0027-voice-callback-receipts.md`, `docs/w4-01-africas-talking-contract.md`.

## Controls to approve before implementation

| Area | Required control | Current state |
| --- | --- | --- |
| Transport | HTTPS only; dedicated route; no wildcard bind; no plaintext HTTP fallback. | Proposed |
| Caller authentication | Platform-generated 256-bit URL token per provider source; store only SHA-256 digest; constant-time comparison; reject unknown/revoked/expired tokens before parsing. | Proposed |
| Bearer-token residual risk | Explicitly accept that a URL token is not provider identity proof; no signature is available from the provider documentation reviewed. | **Decision needed** |
| Rotation | Time-boxed overlap of old/new token digests; one-command revoke; rotation recorded in immutable audit log; no token value in logs. | Proposed |
| IP restrictions | Only add provider source allowlisting after official HTTP Events ranges and trusted-proxy behavior are confirmed. Never derive client IP from a spoofable header. | Pending provider evidence |
| Request bounds | Route-specific raw-body limit (default 16 KiB), exact `application/json`, strict schema, reject unknown fields, reject non-loopback only for synthetic route (public route will be token-gated). | Partially implemented for synthetic route |
| Replay/dedupe | Durable receipt key from provider session ID + event identity + canonical event time; reject stale/out-of-order terminal events; exact replay is idempotent. | Synthetic path implemented; provider key pending payload evidence |
| Correlation | Tenant/attempt identity only from the trusted dispatch binding. Payload supplies neither. Unknown session returns a non-authoritative rejection. | Implemented in receipt boundary |
| Authoritative scope | Callback may only append a receipt and request processing. It must not place calls, return VoiceXML, charge, grant access or directly mutate call state. | Proposed |
| Logging/redaction | Suppress full callback path/query, token, API key, full phone numbers and raw payload in edge/app/tracing/error logs. Log fixed codes and IDs only. | Partially implemented |
| Retention | Retain minimized receipts and audit metadata only under the reviewed schedule; no raw provider body retained by default. | Proposed |
| Rate limits | Per-source and per-session caps before persistence; 429/404 for abuse; kill switch to disable route without redeploy. | Proposed |
| Failure handling | Acknowledge only after durable receipt write. Unverifiable requests fail closed. Processing remains recoverable through PostgreSQL dead-letter flow. | Receipt flow implemented |
| Test evidence | Sandbox callback examples, retry behavior, terminal-state protection, concurrent inserts and recovery verified against isolated PostgreSQL/Redis before production. | Pending |

## Sandbox-only test-call boundary

Allowed now:

- Save sandbox credentials in the existing encrypted configuration surface.
- Run the read-only application-data credential check.
- Use sandbox test numbers for outbound test calls after the outbound adapter is implemented.
- Keep production configuration absent, unverified, unenabled and untouched.

Not allowed without separate approval:

- Production account, production API key, production voice number or production dispatch.
- Public callback ingress or Events URL registration.
- Real customer numbers, billing, payments, deployment or migration application to the main database.

## Decisions needed from you

1. **Residual risk**: approve the URL-token bearer model without provider signature, or require an additional compensating control first.
2. **IP allowlisting**: provider evidence still pending; approve proceeding without it for sandbox-only testing, or wait for official ranges.
3. **Retention period**: choose the receipt/audit retention window (recommend 30 days for sandbox receipts unless policy already defines one).
4. **Sandbox test numbers**: provide only approved test numbers; no real customer numbers.

After these decisions are recorded, the public callback route can be implemented and reviewed. Until then it stays disabled.
