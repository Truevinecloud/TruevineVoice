# W4-04 — live-call preparation checklists (non-billable)

Status: **preparation only**. This document does not authorize a call, a payment, a
migration, public callback ingress, production dispatch, or any provider configuration
change. The readiness report in `docs/w4-04-first-live-call-readiness.md` was accepted as
a preparation report only.

Preserved without change in this task: the corrected `AfricaTalkingVoiceAdapter`, its
43 passing telephony tests, the fail-closed callback controller (still unwired), the
`FakeVoiceAdapter` simulation path, and disabled real dispatch. No shared service was
restarted and no other agent's file was edited.

## 1. Live dashboard verification — owner action (manual)

Do this privately in the existing Africa's Talking browser tab. Do not paste credentials,
API keys or full callback URLs into chat, tickets, code, docs or screenshots. Record only
the non-secret facts in the last column.

| # | Check | Where | Record / stop condition |
| --- | --- | --- | --- |
| 1 | Sign in to the existing account | `account.africastalking.com` | Session restored. If MFA/passkey is needed, complete it privately; do not share codes. |
| 2 | Identify the correct account and applications | Account → Applications | Note the application name and **live** username. Distinguish it from the `sandbox` app. |
| 3 | Confirm a live app exists for Uganda | Application → Products / Settings | If no live app exists, creating one is a manual configuration step, not a billable call. Note the app username. |
| 4 | Confirm Uganda Voice is enabled for that app | Voice section | Uganda is a supported Voice country per official help, but per-app enablement must be observed. Stop if Voice is unavailable. |
| 5 | Inspect Voice → Phone Numbers and the request form | Voice → Phone Numbers | Confirm whether **Category: Test Number** is offered. Do not submit any form yet. |
| 6 | Check live balance / trial credits / invoices | Billing or Wallet view | Note whether any live credit, trial allowance or outstanding invoice exists. Do not pay anything. A zero or unknown balance is a blocker, not permission to top up. |
| 7 | Check for existing live API keys and voice numbers | App settings / Voice → Phone Numbers | Note key existence (never the value) and any allocated number. Stop if an unexpected live key or number is already present. |
| 8 | Confirm callback / Events URL and VoiceXML URL are unset | Voice settings | Both must remain unset. Do not register a public URL. |
| 9 | Confirm destination environment | Local gitignored `.env` | Only `VOICE_CREDENTIAL_ENCRYPTION_KEY` is set locally. `AT_*` and `CAMPAIGN_EXECUTION_MODE` remain absent; dispatch stays disabled. |

Three sign-in handoffs have now ended at the login page (one earlier timeout and two
`continued` outcomes in this task), so items 1–9 remain unverified; see section 9. The sandbox
application-data check (`UGX 162.3373`) is simulator-only evidence and does **not** satisfy
any live item.

## 2. Test Number allocation — owner action (manual)

1. Use the live app dashboard: **Applications → Voice → Phone Numbers → request form**, or
   **Applications → Product Requests → Voice Service → Submit Request**.
2. Select: Product = Voice Service, Country = Uganda, Category = **Test Number**. Accept the
   terms only if the owner approves them.
3. Keep the two paths separate:
   - **Test Number request**: non-billable form submission as far as documented, but **not
     confirmed free**. Wait for written confirmation before assuming any cost.
   - **Regular number**: online contract (PandaDoc) + invoice + payment. This is billable and
     requires separate explicit approval. Do **not** continue down this path.
4. Ask `voice@africastalking.com` in writing, quoting the app username:
   - Is the Test Number free, and are calls made with it free?
   - Is billing per second or per minute, and what increment applies?
   - Are VAT, minimum charges or number fees payable for the test?
   - Is `+256766207549` permitted for this app/number?

   Copy-ready email (fill only non-secret fields; send from the owner's account):

   ```text
   Subject: Pre-launch voice verification — <live app username> — Uganda Test Number

   Hello Africa's Talking team,

   We are preparing one short test outbound call in Uganda from application
   username <live app username>. Before we request or use a Test Number, please
   confirm in writing:

   1. Is the Test Number itself free, and are calls made with a Test Number free?
   2. Are outgoing local calls billed per second or per minute, and what
      increment applies?
   3. Are VAT, minimum charges, setup fees or monthly fees payable for a Test
      Number or this test?
   4. Is destination +256766207549 permitted for this application and number?
   5. Does the /call callActions "Play" action support an MP3 URL hosted on an
      HTTPS endpoint, and are there format or redirect restrictions?

   We will not proceed with any live call or payment until these are confirmed.
   ```

5. After allocation, record the assigned **E.164** number from the dashboard (for example
   `+2567...`). Verify it is a valid E.164 caller ID before it is used as `from`.
6. Confirm the number supports outbound calls and the `Play` call action with a provider
   error message only if needed. Do not treat allocation alone as routing readiness.
7. Until written pricing arrives, the approved maximum for the single prepared call remains
   **UGX 290** (one minute at the published regular outgoing rate), assuming no number fee.
   Do not assume the Test Number or the call is free.

## 3. Recipient authorization — owner + provider (manual)

| # | Requirement | Evidence needed |
| --- | --- | --- |
| 1 | Owner confirms `+256766207549` is an authorized test recipient and consents to one call | Written owner approval naming the number |
| 2 | Provider permits that destination for the app / allocated number | Written reply from `voice@africastalking.com`, or dashboard confirmation |
| 3 | Exactly one recipient, no group/import audience, no extra numbers | Single E.164 value in the prepared plan |
| 4 | No real customer numbers | Owner confirmation; destination is the approved test number only |
| 5 | No retries, no scheduling, no campaign dispatch | Single idempotency key; `CAMPAIGN_EXECUTION_MODE=disabled` until separately authorized |

`+256766207549` passes local E.164 validation via `isPhoneNumber`. That is format
validation only — it is **not** consent or provider authorization.

## 4. Secure sandbox-key rotation — owner action (manual; no credentials displayed)

The sandbox key previously pasted into chat must be treated as exposed. A second key
generated during setup returned HTTP 401 and was discarded. Do not print, copy into chat,
commit, or log either value.

1. Sign in privately to the **Sandbox** app dashboard and open **Settings → API Key** (or
   the application key settings page).
2. Regenerate/rotate the sandbox key. Copy the new value directly from the dashboard into
   the admin form; never into a chat message, file, screenshot or terminal command.
3. In the admin app, open **Settings → Voice Providers → Africa's Talking → Sandbox** and
   paste the new key into the write-only field. Save. The field is cleared on save; leaving
   it blank on a later save keeps the stored key.
4. Run **Test Connection** (read-only application-data lookup). Expect `verified`.
5. Reload the form: confirm the key field is blank, verification shows the new result, and
   the sandbox configuration remains disabled (`enabled=false`). Do not enable dispatch.
6. Remove any local scratch copies of the old key without printing their contents. Check
   tracked files for the key *prefix* only, never the full value; no plaintext secret should
   exist in Git.
7. Record the rotation as a fixed audit note (time, environment, outcome code). Never record
   the value.
8. Stop on a failed verification. Do not try other keys or retry in a loop.

Code-side state already supports this: the API stores an encrypted envelope, the UI field is
write-only, and the local `VOICE_CREDENTIAL_ENCRYPTION_KEY` must be preserved or the stored
ciphertext cannot be read. No code change is required to rotate the key.

## 5. Callback authentication contract — approved vs proposed

| Scope | Contract | Status |
| --- | --- | --- |
| **Approved and implemented** | Internal synthetic route only: `POST /local/callbacks/synthetic`, loopback socket only, 32-byte shared secret from a gitignored file, SHA-256 digest compared with `timingSafeEqual` via `x-truevine-local-callback-key`, exact `application/json`, 16 KiB bounded body, disabled/non-loopback returns `404` before parsing. Tenant and attempt identity come only from the trusted dispatch binding. | Approved; documented in `docs/w4-03-local-callback-verification.md` |
| **Proposed, NOT approved** | Public Events URL with a platform-generated 256-bit URL token per provider source; store only SHA-256 digest; constant-time comparison; time-boxed old/new overlap for rotation; one-command revoke; immutable audit; token and full path never logged. Explicitly a **bearer secret, not provider identity proof**; no provider signature exists in the reviewed docs. | `docs/adr/0027-voice-callback-receipts.md`, `docs/w4-03-provider-callback-controls.md` — approval required |
| **Implemented but unwired** | `apps/api/src/africas-talking-callback/africa-talking-callback.controller.ts`: fails closed when `AT_CALLBACK_API_KEY` is unset, validates session ID, maps documented callback fields, stable dedupe with `ON CONFLICT DO NOTHING`. Module absent from `AppModule`; `POST /webhooks/africastalking` returns `404` locally. | Not approved for public ingress; remains off |

Outstanding decisions (from `docs/w4-03-provider-callback-controls.md`):

1. Accept or reject the URL-token bearer model without a provider signature (residual risk).
2. Provider IP allowlisting: official HTTP Events ranges and trusted-proxy handling are
   unconfirmed. Decide whether to proceed without it for sandbox-only testing.
3. Receipt/audit retention window (recommended: 30 days for sandbox receipts).
4. Approved test numbers permitted to generate callbacks.
5. Replay/stale terminal-event policy, rate limits and kill switch.
6. Real payload/retry evidence and PostgreSQL/Redis recovery evidence on a disposable target.

No public Events URL, VoiceXML endpoint or provider callback route may be enabled until all
applicable decisions are recorded and reviewed. Africa's Talking documents no callback
signature, so an API key alone is not proof of provider identity.

## 6. Reconciliation migration — coordinate with the database owner

**Do not apply.** Request a decision from the human owner/operator who controls the target
database and the release approval manifest. I have not applied it and will not apply it
without written approval.

- Migration: `20261122150000_durable_call_initiation_reconciliation`.
- Scope: additive; creates enum `CallInitiationReconciliationStatus` and table
  `call_initiation_reconciliations` with tenant-scoped columns. No down migration proposed.
- Current status: reported **unapplied** on the main database by read-only
  `prisma migrate status`; applied only in the isolated W402 database. It is **absent** from
  `infrastructure/migrations-reviewed.json`, whose last entry is
  `20261122121200_campaign_call_initiation_operation`.
- Gates: ADR 0011 requires reviewed SQL, backward compatibility with the currently deployed
  code (expand/contract), a rehearsed backup/recovery plan and supervised `prisma migrate
  deploy` by an operator. A manifest entry permits code deployment; it does not apply SQL.

Copy-ready request to the database owner (send only through the approved channel):

> Request for review/approval, not execution: please review migration
> `20261122150000_durable_call_initiation_reconciliation` (additive enum + tenant-scoped
> reconciliation table; no down migration) for SQL correctness, expand/contract
> compatibility with the active release, lock/impact assessment, and a rehearsed backup and
> recovery plan. Confirm the exact target database identity and a supervised execution
> window. If approved, record the decision and add the migration to
> `infrastructure/migrations-reviewed.json` in a separate reviewed change; do not treat my
> request as application authority. After supervised application, verify with read-only
> `prisma migrate status` and ledger checks. Please reply with written approval naming the
> migration, database and window before anyone applies it.

Nothing in this task writes SQL, edits the manifest, changes the migration, or connects to a
production database. Read-only status rechecks are permitted and can be repeated on request.

## 7. Prerecorded audio delivery requirements

The corrected adapter sends one prerecorded file with the documented `callActions` variant,
so playback does not require a public VoiceXML callback:

```json
{
  "username": "<live app username>",
  "from": "<provider-allocated E.164 number>",
  "to": ["+256766207549"],
  "clientRequestId": "<fresh single-use key>",
  "callActions": [{ "actionType": "Play", "url": "https://…/short-greeting.mp3" }]
}
```

Delivery requirements:

| Requirement | Detail |
| --- | --- |
| Absolute HTTPS URL | Adapter rejects non-HTTPS `audioRef` before any request. Use a direct, stable URL. |
| Provider-reachable | Africa's Talking must fetch it without a user session. No `localhost`, private IP, cookie or login. Prefer no redirects. |
| Authorized access | Owner approves the content and hosting location. Use a scoped, expiring signed URL if the bucket is private; ensure the TTL covers dispatch and playback. Do not put secrets in query strings that may be logged. Revoke after the test. |
| Internal endpoint is not usable directly | `GET /organizations/:id/audio-assets/:assetId/content` is behind `SessionGuard`, `OrganizationGuard` and `CsrfGuard`, and `playbackLink` returns a relative path. The provider cannot authenticate to it. |
| Format | Our uploader accepts `audio/mpeg`, `audio/wav`, `audio/mp4`, `audio/ogg`, `audio/webm` after byte-signature checks. Provider `Play` support must be confirmed; **mp3 is the safest choice**. |
| Size / duration | Our validation: 1 byte–10 MB, ≤ 5 minutes. For this test keep it to one short greeting (for example ≤ 30 seconds) to bound cost. |
| Avoid TTS charges | Use a prerecorded file; Google TTS would add USD 0.000008/character. |
| Content | No personal data beyond the approved test; record asset ID/name, not the secret URL. |
| Pre-call check | Read-only `GET` of the URL from a neutral network: expect `200`, correct content type, correct duration, no auth prompt. Confirm it still works immediately before the call. |
| Fallback | If the provider requires VoiceXML instructions instead of `callActions`, callback ingress must be approved first. Do not enable it for this test. |

## 8. Manual action vs work that can be completed through code

### Requires your manual action (or the provider's / database owner's)

- Re-authenticate to the Africa's Talking dashboard and complete all section 1 checks.
- Select/create the live app and request the **Test Number** with Category `Test Number`.
- Obtain written answers on free status, billing increment, VAT/minimums, number fees and
  destination authorization; do not assume the Test Number is free.
- Confirm consent for the single recipient `+256766207549`.
- Rotate the exposed sandbox key through the dashboard and admin form (section 4).
- Decide the four callback controls plus replay/rate/retention items in section 5, and
  approve any future public ingress.
- Have the database owner review/approve (and, if approved, supervise) the reconciliation
  migration; no code path here applies it.
- Approve, host and supply the short prerecorded HTTPS audio file.
- Give final written authorization for exactly one call and the approved maximum charge.

### Completed through code (already done; no further change needed)

- Corrected the outbound adapter to the official Voice endpoint, form/JSON contracts, auth,
  session ID, status mapping, timeouts and E.164 validation; 43 telephony tests pass.
- Added synthetic callback tests and hardened the unwired controller to fail closed and
  deduplicate; public ingress remains `404`.
- Preserved `FakeVoiceAdapter`; real dispatch remains disabled with no `AT_*` env values.
- Recorded the non-executed single-call plan in gitignored
  `.qa-credentials/first-live-call-plan.json` and the evidence in
  `docs/w4-04-first-live-call-readiness.md`.
- Verified locally (read-only): dispatch env absent, webhook `404`, migration unapplied and
  absent from the approval manifest.

### Can be done through code only **after** approvals

- Populate the gitignored plan with the live username, allocated number and audio URL.
- Wire the callback route behind an approved authentication contract.
- Add a one-off, approval-gated single-call runner (campaign dispatch stays disabled).
- Re-run read-only status checks and focused tests.

### Explicitly not done and not authorized here

- No call placed, no payment/billing action, no production credential configured.
- No migration applied, no manifest edited, no callback ingress enabled.
- No shared service restarted, no other agent's files altered.

## 9. Authorization record and coordination log

### Final call authorization — NOT PROVIDED

No valid one-call authorization has been received. Do not infer authorization from access to
an account, browser tab, repository, API key or database. The required written statement must
name all of the following:

```text
I authorize exactly one live outbound test call:
- destination: +256766207549 only (one recipient, no groups or extra numbers)
- content: one short prerecorded message, no TTS, no customer data
- retries: 0; no replay on an ambiguous response; reconciliation only
- scheduling: none; no campaign dispatch
- maximum charge approved: UGX 290 (or <written revised amount>)
- preconditions: dashboard verification, Test Number allocation, written pricing and
  destination confirmation, key rotation, callback decisions, migration approval,
  approved HTTPS audio URL
```

A blank or unsigned copy of this statement in a document is **not** approval. Record the
authorizer, timestamp and exact approved amount only when the statement is actually given.

### Coordination log (this task)

| Item | State |
| --- | --- |
| Dashboard verification (section 1) | **Blocked.** A new Africa's Talking tab was opened at the sandbox Voice Phones URL; it redirected to `/auth/login`. Two private sign-in handoffs returned `continued`, but the tab is still on the login page. No dashboard facts were observed. |
| Copy-ready provider email (section 2) | Prepared above; not sent. No provider reply has been received. |
| Migration-owner request (section 6) | Prepared above; not sent. No approval received; no SQL applied and no manifest edited. |
| Recipient authorization (section 3) | Owner consent and provider confirmation outstanding. |
| Sandbox key rotation (section 4) | Not performed. Exposed key still needs rotation. |
| Callback decisions (section 5) | Outstanding; public ingress remains off. |
| Audio URL (section 7) | Not supplied. |
| Call | **Not placed.** No payment, production credential or dispatch enabled. |

**STOP: final authorization must be provided separately after every blocker above is
resolved. No call will be executed in this task.**
