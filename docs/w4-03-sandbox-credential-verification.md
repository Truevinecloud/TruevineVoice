# W4-03 Africa's Talking sandbox credential verification

Status: **verified (read-only)**. Sandbox application credentials are stored encrypted and
pass the application-data credential check. No calls were placed, no campaign dispatch is
enabled, and production configuration is absent.

Recorded: 2026-11-23.

## Scope

- Create the Africa's Talking account and verify its email (owner performed the interactive
  steps; no secret was entered by an agent).
- Generate a Sandbox app API key and store it locally only.
- Save the sandbox credentials through the existing admin surface
  (**Settings -> Voice Providers -> Africa's Talking**) using the encrypted
  `voice_provider_configurations` store.
- Run the read-only application-data credential check against
  `api.sandbox.africastalking.com/version1/user`.

Explicitly out of scope and still blocked: outbound calls, campaign dispatch, provider
callbacks/Events ingress, production credentials, activation of voice routing, billing.

## Storage

| Item | Location | Notes |
| --- | --- | --- |
| Sandbox API key | `F:\TruevineVoice\.qa-credentials\africas-talking-sandbox-key.txt` | Gitignored (`.gitignore:63`); never printed by QA tooling |
| Credential encryption key | `VOICE_CREDENTIAL_ENCRYPTION_KEY` in repository-root `.env` | Gitignored local secret; 32-byte base64; not committed |
| Encrypted credential | `public.voice_provider_configurations` | Ciphertext only; no plaintext key in the database |

The API key was also pasted into a chat transcript during setup. It is treated as exposed:
rotate it in the Sandbox dashboard before any production or shared use, then update it through
the same admin form. The working check below used the version of the key that returned HTTP 200.

## Database state (read-only, main `truevine_voice`)

Migration `20261120130000_voice_provider_configuration` is applied in `_prisma_migrations`
(`finished_at = 2026-11-22T11:34:59.148Z`, one step).

| environment | username | voice_number | enabled | check_result | version | ciphertext length |
| --- | --- | --- | --- | --- | --- | --- |
| `SANDBOX` | `sandbox` | *(empty)* | `false` | `verified` | 4 | 146 |
| `PRODUCTION` | *(no row)* | - | - | - | - | - |

`voiceReady` is always `false` in this release; `Activate` records Platform Owner intent only
and is not dispatch authorization. Dispatch remains hard-disabled.

## Verification evidence

Direct read-only check (same request the service issues):

```
GET https://api.sandbox.africastalking.com/version1/user?username=sandbox
apiKey: <sandbox key>
Accept: application/json
-> 200 {"UserData":{"balance":"UGX 162.3373"}}
```

Admin **Test Connection** result: `verified` at 2026-11-23 12:00:31 local
(`checked_at = 2026-11-23T09:00:31.953Z`), persisted with `enabled = false`.

A second key generated during setup returned `401` and was discarded; the key that returned
`200` is the one stored. Mixing sandbox and live keys also produces `401`, which is why the
check is read-only and environment-specific.

## Callback ingress correction

A rebuild picked up an uncommitted `AfricaTalkingCallbackModule` import in
`apps/api/src/app.module.ts` and exposed `POST /webhooks/africastalking`. That route was not in
the previously running artifact and public callback ingress is not approved, so the import and
its module entry were removed from `AppModule` (the module and controller files remain on disk,
unwired). After rebuild:

- `/webhooks/africastalking` is absent from the route map.
- A loopback probe returns `404`.
- `voice_callback_receipts` contains zero `africas-talking` rows.

Security note for any future wiring: the controller fails closed when `AT_CALLBACK_API_KEY`
is unset (`expectedApiKey` null rejects every POST with `503`). Its `apikey` header check is not
an approved authentication contract; it must still be reviewed for the documented bearer-token,
IP-allowlist and retention decisions in `docs/w4-03-provider-callback-controls.md` before the
module is mounted.

## Provider limitation

Africa's Talking states its Voice Sandbox is not operational, and the outbound call URL in the
W4-01 contract (`voice.sandbox.africastalking.com/call`) does not match the adapter's current
`/version1/call` endpoint. No test call was attempted. A provider-issued Test Number or live
application is still required before any call-path verification.

## Commands used

- `npm run prisma:migrate:status` - only
  `20261122150000_durable_call_initiation_reconciliation` reported unapplied; nothing applied.
- Read-only `SELECT` on `voice_provider_configurations`, `_prisma_migrations` and
  `voice_callback_receipts` through the generated Prisma client.
- `npm run typecheck --workspace @truevine/api` - passed.
- `npm run build --workspace @truevine/api` - passed.
- `GET http://127.0.0.1:3001/health` - 200.
