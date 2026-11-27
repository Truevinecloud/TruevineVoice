# W4-04 — first live outbound call readiness

Status: **prepared, NOT executed**. No real call was placed. No payment, billing action,
public callback ingress, campaign dispatch or production credential was enabled.

Authorized recipient for the single prepared test: `+256766207549` (one recipient only).

Non-billable preparation companion: `docs/w4-04-live-preparation-checklists.md` (dashboard,
Test Number, recipient authorization, key rotation, callback contract, migration handoff and
audio delivery). This report and its companion are preparation only, not call authorization.

## 1. Coding implementation status

### Outbound adapter — corrected to the official contract

`packages/telephony/src/adapters/africas-talking/africa-talking-voice.adapter.ts`

The previous implementation did not match Africa's Talking's documented Voice API. Fixed:

| Item | Before | Now |
| --- | --- | --- |
| Endpoint | `api[.sandbox].africastalking.com/version1/call` | `voice[.sandbox].africastalking.com/call` (SDK: `VOICE_URL + '/call'`) |
| Auth | `apikey` header only | `apikey` header **and** `username` in the body |
| Idempotency | idempotency key never sent | sent as `clientRequestId` (provider echo + local idempotency) |
| Provider session | read `entry.requestId` (never present) | reads `entry.sessionId`; rejects `None`/missing instead of losing callback correlation |
| Success codes | any 2xx | 200 and 201 only (SDK rule) |
| Failure statuses | `InvalidPhoneNumber`, `DestinationNotSupported`, `InsufficientCredit` fell through to `DIALING` | hard `invalid_request`, no request treated as queued |
| Number validation | destination only checked non-empty | `to` and `from` must be E.164 via `isPhoneNumber` |
| Timeouts/network | raw fetch exception | `TelephonyError('provider_unavailable', retryable: true)` with no key leakage |
| Prerecorded message | unsupported | optional `audioRef` HTTPS URL sends the documented `callActions` JSON with `Play`, so no public VoiceXML callback is needed to play the greeting |
| Modes | implicit | explicit `SANDBOX` / `PRODUCTION` host selection; `FakeVoiceAdapter` remains simulation and is the default |

`hangUp` / `fetchCallStatus` deliberately throw `not_found`: the REST API used here has no
per-call polling or hang-up endpoint. Final state must come from reviewed callback events or
the provider dashboard read-only.

### Dispatch remains disabled

- `CAMPAIGN_EXECUTION_MODE` defaults to `disabled`; `AT_VOICE_PROVIDER` is unset in the local
  gitignored `.env` (only `VOICE_CREDENTIAL_ENCRYPTION_KEY` is present).
- The worker therefore still uses `FakeVoiceAdapter`; no real provider call path can run.
- Reconciliation and duplicate prevention remain in
  `apps/worker/src/campaigns/campaign-call-initiation.service.ts` and
  `call-initiation-reconciliation.service.ts` (tenant/attempt-scoped claim, one operation per
  canonical fingerprint, `UNKNOWN` on missing provider session id).
- The simulation adapter and its replay tests were preserved unchanged.

### Callback readiness

- `apps/api/src/africas-talking-callback/` remains **unwired**: `POST /webhooks/africastalking`
  is absent from the route map and a loopback probe returns `404`.
- The controller now fails closed when no `AT_CALLBACK_API_KEY` is configured (previously it
  accepted every POST), validates the session id, parses the documented callback fields
  (`sessionId`, `isActive`, `callSessionState`, `durationInSeconds`, `currencyCode`, `amount`),
  and deduplicates on a stable `(source, sessionId, state, isActive)` hash with
  `ON CONFLICT DO NOTHING`.
- No Events URL, VoiceXML endpoint or public URL was configured. The authentication contract in
  `docs/w4-03-provider-callback-controls.md` is still awaiting owner approval; the API-key-only
  check is not a signed provider identity proof (Africa's Talking documents no callback
  signature).
- Synthetic callback tests cover fail-closed, bad key, valid receipt, malformed session id,
  dedupe stability and state mapping.

## 2. Tests

| Scope | Result |
| --- | --- |
| `@truevine/telephony` typecheck, lint, build | passed |
| `@truevine/telephony` unit tests | **43/43** (5 files), including 12 new adapter tests |
| `@truevine/api` typecheck, lint, build | passed |
| `@truevine/api` callback controller spec | **6/6** |
| `@truevine/api` full unit suite | **1049/1051**; the 2 failures were 5s timeouts in `test/technical.http.spec.ts` under parallel load. Isolated rerun: **18/18** passed. |
| `@truevine/worker` typecheck | passed |
| `@truevine/worker` unit tests | **34/34** (7 files): claim/reconciliation, uncertain provider outcome, no-provider-replay, duplicate/replay, disabled-by-default |
| `prisma migrate status` | read-only; one migration still unapplied (see blockers) |

No W4-02 recovery test, Round 4 playback, campaign-delete or tenant-isolation test was rerun.
No shared API or worker process was restarted.

## 3. Sandbox versus live readiness

| Area | Sandbox | Live |
| --- | --- | --- |
| Credential | Stored encrypted; `GET /version1/user` returned HTTP 200 with `UGX 162.3373` | No application, username, key or row configured |
| Voice operation | **Not operational** per Africa's Talking (2026-02-13 help article) | Voice is available in Uganda (2026-10-08 help article) |
| Calling number | Sandbox UI shows a Voice/Phone Numbers menu, but no real number can be used | Must be a provider-issued E.164 number; normal allocation needs contract + invoice + payment; a **Test Number** must be requested from the app dashboard |
| Balance meaning | Simulator-only credit; cannot pay for a real call | Not verified — dashboard login expired before account checks |
| Dispatch | Disabled | Disabled |

The stored sandbox key was previously pasted into chat and is treated as exposed. It must be
rotated before any further use; rotating it will require re-saving the credential through
`Settings → Voice Providers`. A second key generated during setup returned 401 and was discarded.

## 4. Can the first real call be free?

**Not verified — assume it is chargeable.** Africa's Talking documents:

- The sandbox is a free test environment that routes to a simulator; live traffic goes to real
  phones and is charged.
- A Voice **Test Number** can be requested through the live app dashboard
  (`Voice → Phone Numbers → request form → Category: Test Number`), but the official article does
  **not** say the number or calls made with it are free.
- A normal number requires an online contract, invoice and payment before allocation.
- A 2026 Africa's Talking talk mentioned "free resources … up to 2 weeks in live environment"
  including a voice number, but this is not a published pricing term and must be confirmed in
  writing by `voice@africastalking.com`.

Therefore: no verified free real call exists today. Do not treat the sandbox `UGX 162.3373`
balance as live credit.

## 5. Confirmed charges and estimate

Official Uganda pricing (`https://africastalking.com/pricing`, Help Center "Voice Pricing Uganda"):

| Item | Published charge |
| --- | --- |
| Regular outgoing call | **UGX 290 per minute** |
| Regular incoming call | UGX 45 per minute |
| Regular voice number set-up | UGX 200,000 |
| Regular voice number monthly maintenance | UGX 40,000 |
| Toll-free number set-up / maintenance | UGX 200,000 / UGX 40,000 |
| Google TTS | USD 0.000008 per character (standard) — avoided by using `Play` with prerecorded audio |
| Billing increment | **Not published on the pricing page** — provider confirmation required |

Conservative maximum for the prepared single short call: **UGX 290** (one minute at the regular
outgoing rate), assuming no number fee is charged for an approved Test Number. If a regular
number must be procured, add UGX 200,000 set-up + UGX 40,000 monthly. No charge was incurred.

## 6. Voice number availability

- Uganda is listed as a supported Voice country.
- A live application and a provider-issued `from` number are mandatory for real outbound calls.
- A Test Number is requested in the live app dashboard; normal numbers need contract and payment.
- No number is allocated to this account as far as the local system knows; the dashboard session
  expired before this could be confirmed. **Owner action required.**

## 7. Prepared single live test (NOT executed)

| Field | Value |
| --- | --- |
| Destination | `+256766207549` only (E.164, Uganda) |
| Recipients | 1 |
| Mode | `PRODUCTION` adapter, live app username and live API key in gitignored env only |
| Calling number | `<provider-allocated E.164 number>` — not yet available |
| Message | One short prerecorded HTTPS audio file via `callActions: [{ actionType: 'Play', url }]` |
| Retries | none; single idempotency key; no replay |
| Campaign scheduling | none |
| Payment / billing | none without explicit approval |
| Maximum charge to approve | UGX 290 for the call (plus any provider-confirmed number fee) |
| Expected outcome | `Queued` with a `sessionId`; final outcome read from provider dashboard until callback ingress is approved |

The prepared parameters are also stored locally (gitignored) at
`.qa-credentials/first-live-call-plan.json` with `status: prepared_not_executed`.

## 8. Outstanding blockers

1. **Rotated credential** — exposed sandbox key must be rotated; live key does not exist.
2. **Live application / Test Number** — owner must sign in to the Africa's Talking dashboard,
   create or select a live app for Uganda, request a Test Number (Category "Test Number"), and
   supply the allocated E.164 number. The dashboard re-automation attempt timed out.
3. **Free-call and pricing confirmation** — written answer from Africa's Talking on whether the
   Test Number and the test call are free, and the billing increment. Until then the approved
   maximum is UGX 290.
4. **Recipient authorization** — provider must confirm `+256766207549` is permitted for this
   app/number; no authorization was verifiable from local state.
5. **Callback security approval** — decisions in `docs/w4-03-provider-callback-controls.md`
   (bearer-token residual risk, IP evidence, retention, approved test numbers) remain open.
   Public ingress stays off.
6. **Migration** — `20261122150000_durable_call_initiation_reconciliation` is the only unapplied
   migration. Applying it needs the database owner's approval; it was **not** applied.
7. **Single-call dispatch path** — no one-off, approval-gated live call runner exists and
   campaign execution is hard-disabled. Owner must choose between a one-off gated runner and a
   tightly scoped single-recipient campaign; no dispatch is enabled yet.
8. **Audio URL** — an HTTPS URL for the short prerecorded file must be provided and hosted.

## 9. Exact steps before the first live call

1. Rotate the exposed sandbox API key in the Sandbox dashboard, then re-save it through the
   admin Voice Providers form. Discard the rejected (401) key.
2. Re-authenticate to `account.africastalking.com` and confirm: live app exists, Uganda Voice is
   enabled, no unexpected live balance/credit, and the Voice → Phone Numbers request form offers
   "Test Number".
3. Email `voice@africastalking.com` asking, in writing: (a) is the Test Number free, (b) is the
   first short call to `+256766207549` free, (c) is billing per second or per minute, (d) any VAT
   or minimum, (e) is that destination authorized. Attach the app username.
4. Request and receive the Test Number; record its E.164 value.
5. Get database-owner approval and apply only
   `20261122150000_durable_call_initiation_reconciliation`; re-run `prisma migrate status`.
6. Get explicit approval for the callback security contract. Keep `AfricaTalkingCallbackModule`
   unwired until then; never mount it with an unset `AT_CALLBACK_API_KEY`.
7. Host the short prerecorded audio at an HTTPS URL and record it in the local plan.
8. Set the live credentials only in the gitignored local environment: `AT_VOICE_PROVIDER=true`,
   `AT_USERNAME`, `AT_API_KEY`, `AT_VOICE_NUMBER`, `AT_ENVIRONMENT=PRODUCTION`. Leave
   `CAMPAIGN_EXECUTION_MODE=disabled` until the owner authorizes the single dispatch.
9. Obtain the owner's explicit, written approval naming exactly one call, destination
   `+256766207549`, one prerecorded message, no retries, and the maximum charge (UGX 290 unless
   provider confirms otherwise).
10. Execute once with a fresh idempotency key, capture the returned `sessionId`, and read the
    final outcome/cost from the provider dashboard. Do not retry even on an ambiguous response —
    use the reconciliation path instead.

**STOP: no call is placed until steps 1–10 are complete and the owner gives final approval.**

## Sources

- `<internal>` `docs/w4-01-africas-talking-contract.md`, `docs/w4-03-provider-callback-controls.md`,
  `docs/w4-03-sandbox-credential-verification.md`
- Official Node SDK: `lib/common.js` (`VOICE_URL`) and `lib/voice.js` (`POST /call`, form
  `username/from/to/clientRequestId`, HTTP 200/201)
- `https://developers.africastalking.com/docs/voice/make_call`
- `https://developers.africastalking.com/docs/voice/actions/call_actions`
- `https://developers.africastalking.com/docs/voice/handle_calls`
- `https://help.africastalking.com/en/articles/11532610-voice-sandbox`
- `https://help.africastalking.com/en/articles/13762314-voice-number-request-acquisition`
- `https://help.africastalking.com/en/articles/11532624-countries-offering-voice-product`
- `https://help.africastalking.com/en/articles/5947646-how-can-ensure-that-the-post-request-to-my-callback-url-is-coming-from-africa-s-talking-and-not-some-other-place`
- `https://africastalking.com/pricing`
