# W4-03 local synthetic callback verification

Status: **internal synthetic pipeline only**. Public/provider callback ingress remains disabled and requires separate security approval.

## Approved boundary

- The only callback route is `POST /local/callbacks/synthetic`, reachable only from a loopback socket.
- Caller identity is a 32-byte shared secret read from a gitignored file and compared by SHA-256 digest with `timingSafeEqual`. The header is `x-truevine-local-callback-key`.
- Payload identity is limited to `sessionId`, `state` and `occurredAt`; tenant and attempt identity come only from the trusted dispatch-side binding. Caller-supplied `organizationId` is rejected.
- Media type must be exactly `application/json`. The route-specific raw body limit defaults to 16 KiB and is bounded to 1–65536 bytes.
- Disabled configuration returns `404` on the exact route before any body parsing. Non-loopback sockets also return `404`.
- No provider adapter, provider payload mapping, VoiceXML response, Events URL, signature verification, IP allowlist or public webhook is implemented.

## Configuration

Generated credential (value is never printed):

```powershell
node infrastructure/scripts/local-callback-key.mjs
```

API opt-in:

```text
LOCAL_SYNTHETIC_CALLBACK=1
LOCAL_SYNTHETIC_CALLBACK_KEY_FILE=<gitignored key path>
LOCAL_SYNTHETIC_CALLBACK_BODY_LIMIT_BYTES=16384
API_HOST=127.0.0.1
```

The gate refuses production, wildcard `API_HOST`, a missing key file and out-of-range limits. The main development database additionally requires explicit `LOCAL_SYNTHETIC_CALLBACK_ALLOW_MAIN_DB=1`; do not set it for general QA.

## Verification performed

- `apps/api/src/local-callbacks/local-callback.middleware.spec.ts`: 4 tests passed. Covers disabled 404, non-loopback 404 before parsing, exact content-type enforcement including IPv4-mapped loopback, and oversize 413.
- `apps/api/src/local-callbacks/local-callback.service.spec.ts`: credential, payload, stale-event and persistence-boundary behavior remains covered by the existing suite.
- `npm run typecheck --workspace @truevine/api`: passed.

## Still pending

- Public/provider callback route and Events URL (not authorized).
- Approved provider verification contract, replay limits, rotation, retention, log suppression and rate limits.
- PostgreSQL/Redis integration E2E for receipt processing and the optional callback worker loop.
- Exposing callback diagnostics through an approved read-only surface.

Visible Chrome confirmation after local servers were restored: the admin Voice Providers page still states that callback and events URLs will appear only when HTTPS callback handling is available; technical overview reports voice provider and queues as `not_integrated`. No public ingress was exposed.
