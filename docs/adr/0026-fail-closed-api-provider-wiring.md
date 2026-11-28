# ADR 0026 — Fail-closed API provider wiring

Status: accepted for implementation; provider activation and production approval withheld

## Context

The API contains provider configuration, callback, SMS fallback, and observability
modules, but the root module deliberately left them unregistered. Registering them
changes the production HTTP surface, so the wiring must not create an
unauthenticated provider ingress, a live SMS path, or a chargeable side effect.
Africa's Talking credentials must remain absent by default, and an otherwise
healthy production boot must not depend on them.

## Decision

`AppModule` registers only these API-side commercial modules:

- `VoiceProvidersModule`
- `AfricaTalkingCallbackModule`
- `SmsFallbackModule`
- `ObservabilityModule`

Local callback, top-up integration, SMS provider configuration, and worker
processors remain unwired. No live telephony or SMS adapter is registered.

All registered paths are fail-closed:

- Africa's Talking callbacks require a trimmed key of at least 32 characters. A
  missing, blank, or weak key resolves to `null` and every callback receives 503.
  A supplied key is compared in constant time. The controller only records a
  durable, deduplicated receipt; it performs no settlement, charge, or dispatch.
- A missing or malformed `VOICE_CREDENTIAL_ENCRYPTION_KEY` resolves to `null`
  rather than aborting startup. Voice credential writes and connection checks
  return 503 without an outbound request when the key is unavailable.
- The SMS port is unavailable by default. A synthetic adapter is selectable only
  outside production with an explicit opt-in; production remains unavailable even
  if the opt-in flag is present.
- Metrics remain a read-only platform-operations endpoint behind the existing
  session and platform guards. The admin proxy allowlist is unchanged.

No provider is activated by this decision, and no production secret, account, or
configuration value is introduced.

## Consequences

- Production startup succeeds with all provider credentials absent and makes no
  external provider requests.
- The new routes exist but are inert or authenticated until explicit, reviewed
  configuration is supplied.
- Admin and customer route authorizations remain at the API boundary; hiding a
  route behind the admin proxy is not an authorization mechanism.
- Tests assert registration, guard metadata, gate behavior, receipt deduplication,
  and production startup so later changes cannot silently open these paths.
- Live provider activation, payment collection, and worker processor registration
  remain separate, explicitly approved changes.
