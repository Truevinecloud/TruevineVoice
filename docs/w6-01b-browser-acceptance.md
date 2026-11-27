# W6-01B isolated paired-Chrome browser acceptance

Date: 2026-11-24

**Result: isolated browser acceptance passed for the W6-01 customer lifecycle and Platform Admin emergency-stop negative controls listed below. This is not W6-01 production readiness.** Migration approval, the approved cost/reserve policy, the reviewed-migrations manifest, stale-`HELD` handling, rollback/recovery policy and deployment authorization remain unresolved. Emergency-stop recovery was not implemented, and no production deployment or data change was made.

## 1. Isolation and evidence target

| Item | Isolated W6-01B value |
| --- | --- |
| Web | `http://127.0.0.1:3200` (dedicated Next dev server) |
| API | `http://127.0.0.1:3201` (QA-only Nest Testing bootstrap) |
| Admin | `http://127.0.0.1:3202/admin` (dedicated Next dev server with `/admin` base path) |
| PostgreSQL | `truevine_w601b_qa` on loopback `127.0.0.1:55434` |
| Redis | container `truevine-w601b-redis`, `redis://127.0.0.1:56384/0` |
| Queue | `w601b-campaign-execution` |
| Provider | fake adapter only (`AT_VOICE_PROVIDER=false`), `callbackSource: "fake"` |
| Synthetic reserve | `1000` minor units UGX, `policyVersion: w601-synthetic-fixed`, isolated only |
| Browser group | paired Chrome group `W6-01B acceptance`; dedicated customer, Org C, viewer and admin tabs |
| Credentials | synthetic accounts from `.qa-credentials/w601b-qa-credentials.json`; pasted via clipboard without printing values |

W5-03E (`3100/3101`, `truevine_w503e_qa`, Redis `56381`) and W6-01 (`truevine_w601_qa`, Redis `56382`) were not used, stopped or restarted. No real provider, payment provider, callback, production database, production migration, commit, push or deployment was contacted.

Evidence files are outside Git at `C:\Users\ntaph\AppData\Local\Temp\opencode\w601b-evidence\`, with screenshots under `screenshots\`, JSON state snapshots and job records in the root of that folder, and probe logs in `probe.log` / `probe.err.log`.

## 2. Customer browser checks

All actions below were performed through paired Chrome as real page interactions. API and database state were checked after the browser actions, not inferred from UI text.

| Check | Browser observation | Authoritative outcome | Result |
| --- | --- | --- | --- |
| Status visibility | Campaign review shows `Active record`, frozen draft fields and the dispatch controls. | `dispatchState: RUNNING`, `dispatchEpoch: 1`. | Pass |
| Previously initiated call visible | Analytics shows 1 call attempt, `UGX 0` spend and reconciliation with the ledger; the attempt is `2f13e4c6-...`. | One fake-provider invocation (`fake-1`) and one `DIALING` call attempt. This call predated the lifecycle actions and was not placed again. | Pass |
| Pause | Button `Pause calls` produced `New calls are paused. Calls the provider already accepted are still reconciled.` and `Paused by an organization member. Existing call history is unchanged.` | `PAUSED`, reason `customer_pause`, epoch `1 → 2`; audit `campaign.paused SUCCESS`; fake count stayed `1`. A job after pause returned `{status:"paused"}` with no new invocation. | Pass |
| Resume | Button `Resume calls` produced `Dispatch resumed. Previously initiated calls are not placed again.` | `RUNNING`, reason cleared, epoch `2 → 3`; audit `campaign.resumed SUCCESS`. A job after resume returned the prior attempt with `replayed:true`; fake count stayed `1`. | Pass |
| Cancel | Button `Cancel campaign` produced `Dispatch cancelled. Call and financial history is preserved.` and removed the lifetime controls. | `CANCELLED`, reason `customer_cancel`, epoch `3 → 4`; audit `campaign.cancelled SUCCESS`. A job after cancel returned `{status:"cancelled"}` with no new invocation. | Pass |
| Cancelled restart prevention | Direct browser `POST .../resume` returned HTTP `409`. | Body: `campaign_cancelled`, `A cancelled or emergency-stopped campaign cannot be restarted.` Audit recorded `authorization.denied` / `attemptedAction: campaign.resumed`. | Pass |
| Insufficient balance | Org C owner sees `Paused because the approved reserve was not covered. Existing call history is unchanged.` | Wallet balance `500` UGX is below the synthetic `1000` UGX reserve; job outcome `{status:"blocked", reason:"insufficient_balance", reconciliationRequired:false}`; a `QUEUED` call attempt exists; fake count stayed `1`. | Pass |
| Spending-cap restriction | No spending-cap field, API route, UI control or schema model exists in this codebase. | Only the approved-reserve gate was exercised; the isolated synthetic `1000` UGX value is not a production policy. | Not verifiable / deferred — no implemented cap to test; no policy invented. |
| Viewer restrictions | Viewer sees `Campaign inventory` with `No campaign controls are available to this role.` and no pause/resume/cancel controls. | Direct browser `POST .../pause` returned HTTP `403 permission_denied`. | Pass |
| Cross-tenant denial | Owner of Org A made browser `GET` and `POST` requests using Org B's organization path and campaign id. | Both returned HTTP `403 permission_denied`; the foreign campaign remained `RUNNING`, epoch `1`. | Pass |
| Reconciliation visibility | Campaign analytics shows exact call attempts, current states and integer UGX customer charge, with the `Reconciled with ledger` indicator. | Analytics matched the authoritative `call_attempts`, wallet entries and fake invocation counter; no estimated cost was presented. | Pass |

Screenshots: `customer-initial-detail-desktop.png`, `customer-initial-detail-mobile.png`, `customer-prior-call-visible-desktop.png`, `customer-paused-confirmation-desktop.png`, `customer-resumed-confirmation-desktop.png`, `customer-cancelled-confirmation-desktop.png`, `customer-cancelled-mobile.png`, `customer-low-balance-desktop.png`, `customer-viewer-readonly-desktop.png`, `customer-stopped-mobile.png`, `customer-resume-after-stop-api-denial.png`.

## 3. Platform Admin browser checks

| Check | Browser observation | Authoritative outcome | Result |
| --- | --- | --- | --- |
| Operations dashboard | Authorized operations account sees organizations, campaign dispatch states/epochs, stop detail and `Emergency stop` buttons. | Dashboard requests completed with HTTP `200`; health reported Postgres and Redis `up` while the provider health card remained `not_integrated`. | Pass |
| Unauthorized platform user | Support account sees the Support workspace, not the Operations controls; no `Emergency stop` button is rendered. | Direct browser `POST .../emergency-stop` returned HTTP `403` with `This action requires Truevine platform access.` | Pass |
| Confirmation gate | Clicking `Emergency stop` opened the `role="dialog" aria-modal="true"` confirmation with reason code and `Confirm emergency stop`; no mutation happened before confirmation. | Campaign was still `RUNNING`, epoch `1` at this point. | Pass |
| Emergency stop | Confirming produced `Campaign stopped and the action was recorded.` | `status: COMPLETED`, `dispatchState: CANCELLED`, `dispatchStopReason: emergency_stop`, `emergencyStoppedAt: 2026-11-24T14:47:34.557Z`, epoch `1 → 2`. | Pass |
| Stopped indicator | Row shows `Stopped <timestamp>`, `CANCELLED / Epoch 2`, `Platform emergency stop`, `Emergency stopped`; no stop button remains. Customer detail shows `Stopped by a platform emergency stop. Existing call history is unchanged.` and no resume control. | Browser-visible state matches PostgreSQL. | Pass |
| Audit record | — | `platform.campaign.emergency_stopped`, `scope: PLATFORM`, `outcome: SUCCESS`, actor `w601b-operations@example.invalid`, reason `security_incident`, before/after and marker in metadata. | Pass |
| No new paid work after stop | Enqueue before stop had fake count `1`. Jobs `after-emergency-stop`, `after-worker-restart` and `after-final-worker-restart` all returned `{status:"cancelled"}`. | Fake count remained `1` for every check; no new reservation or call attempt was created for the stop target. | Pass |
| Worker restart persistence | The isolated probe process was stopped and replaced twice against the same DB/Redis/queue; final `W601B_PROBE_READY` reports PID `4752`, database `truevine_w601b_qa`, Redis port `56384`, fake callback source. | Post-restart snapshot retained marker, reason, epoch and audit unchanged; post-restart enqueue was cancelled with no provider call. | Pass |
| Customer resume rejected after stop | Direct browser `POST .../resume` on the stopped campaign returned HTTP `409`. | Body: `campaign_cancelled`; audit `authorization.denied` / `attemptedAction: campaign.resumed`; no dispatch mutation. | Pass |
| No recovery surface | No re-enable/unstop/override button, route, script result or visible workflow was found or added. | Stopped campaigns remained terminal under ADR 0013/0032. | Pass |

Screenshots: `admin-dashboard-desktop.png`, `admin-dashboard-mobile.png`, `admin-support-no-emergency-stop-desktop.png`, `admin-emergency-stop-confirmation-desktop.png`, `admin-emergency-stopped-desktop.png`, `admin-emergency-stopped-mobile.png`.

Browser XHR/fetch capture counters at completion: customer web tab 60 entries / 47 responses / 13 failures (dev/HMR and denied requests included), operations/admin tab 28 entries / 28 responses / 0 failures, Org C tab 22 entries / 17 responses / 5 failures, viewer tab 28 entries / 23 responses / 5 failures. No truncated admin entries; two truncated response bodies in the non-admin tabs were unrelated page payloads. Credentials were redacted by the capture tool.

## 4. Authoritative reconciliation

Final snapshots: `state-after-prior-call.json`, `state-final.json`, `state-final-after-restart.json`.

| Artifact | Final isolated state |
| --- | --- |
| `W6-01B customer controls` | `ACTIVE / CANCELLED`, epoch `4`, reason `customer_cancel` |
| `W6-01B platform stop target` | `COMPLETED / CANCELLED`, epoch `2`, reason `emergency_stop`, marker `2026-11-24T14:47:34.557Z` |
| `W6-01B low balance` | `ACTIVE / PAUSED`, epoch `2`, reason `insufficient_balance` |
| `W6-01B tenant B target` | `ACTIVE / RUNNING`, epoch `1`, untouched by cross-tenant attempts |
| Fake-provider invocation count | `1` globally and `1` detail entry; `fake-1` is the single prior initiation. Pause, resume replay, cancel, low balance, stop and all post-restart jobs produced `0` new invocations. |
| Call attempts | `2`: one `DIALING` for customer controls, one `QUEUED` for the low-balance campaign. |
| Wallet | Org A `20000` UGX, Org C `500` UGX; no wallet adjustment was made by lifecycle actions. |
| Reservations | One `HELD` row for Org A, `1000` UGX; this is a non-ledger coordination row, not a wallet entry or financial event. |
| Audits | `6`: `campaign.paused`, `campaign.resumed`, `campaign.cancelled`, two `authorization.denied` records for attempted resumes, and `platform.campaign.emergency_stopped`. |
| Customer analytics | Exact integer UGX spend shown as `UGX 0`; no estimate or provider field leaked into the customer view. |

The earlier accepted backend evidence (`docs/w6-01-campaign-dispatch-reliability-verification.md`) recorded `13` worker and `3` API W6-01 tests plus pre-provider guard results. These browser results add the real paired-Chrome layer without changing that accepted implementation.

## 5. Migration review evidence

- `node scripts/testing/w601b-isolated-env.mjs npm run prisma:migrate:status` reported `31 migrations found` and `Database schema is up to date!` for `truevine_w601b_qa` at `127.0.0.1:55434`.
- The proposal `packages/database/prisma/migrations/20261124130000_w601_campaign_reliability/migration.sql` was read-only reviewed in `docs/w6-01b-migration-review-handoff.md`.
- `infrastructure/migrations-reviewed.json` was not changed. The W6-01 migration and three other migration directories remain absent from it.
- No production migration was applied, no migration file was edited, and no schema drift, rollback, reserve-policy or trigger/epoch decision was silently resolved.

## 6. Harness corrections made during acceptance

These were required for the browser checks to exercise the accepted backend; they do not change W6-01 reliability behaviour:

1. `apps/web/src/app/api/[...path]/route.ts` — added explicit POST proxy allowlist entries for customer `pause`, `resume` and `cancel`. Before this, the customer detail buttons returned `Not found` even though the API had the routes. `apps/web/src/lib/proxy.spec.ts` now includes the three allowed method/path pairs.
2. `scripts/testing/w601b-enqueue.mjs` — reused the isolated Redis client through `createBullConnection` instead of constructing BullMQ options from a URL (which attempted `127.0.0.1:6379`), connected the lazy client, and corrected the composite Prisma key to `{ organizationId, id: campaignId }`.
3. `scripts/testing/w601b-state-snapshot.mjs` — new read-only reconciliation script that refuses any target other than `truevine_w601b_qa` / Redis `56384`; fixed a raw SQL varchar/uuid comparison while writing it.
4. `scripts/testing/w601b-dispatch-probe.mjs` — removed an unused `createBullConnection` import found by full lint. The running probe was restarted afterward.

No application source outside the web proxy allowlist and its test was changed. No lint rule, compiler strictness, test assertion or failing test was weakened.

## 7. Quality gates

| Command | Result |
| --- | --- |
| `npm.cmd run typecheck` | Passed all workspaces. |
| `npm.cmd run build` | Passed packages and all four apps; Next builds compiled and generated pages successfully. |
| `npm.cmd run test` | Passed: admin 144, API 1144 passed / 4 skipped, web 424, worker 67, audio 7, auth 116, database 5, domain 58, messaging 21, queue 12, shared 19, telephony 59, deployment 381 passed / 3 skipped. POSIX-only db-verify and backup runtime suites skipped by their own platform guards; static backup coverage ran. |
| `npm.cmd exec -- eslint <five changed W6-01B files>` | Passed with no output. |
| `npm.cmd run lint` | Failed: 5 errors and 1 warning, all unrelated to W6-01B and not touched here. See `docs/w6-01b-lint-owner-notifications.md` for draft owner notifications. |
| `node scripts/testing/w601b-isolated-env.mjs npm run prisma:migrate:status` | Passed on the isolated QA database only. |

Root lint findings: `no-unused-vars` in `apps/api/src/payments/top-up-integration.controller.ts`, `no-explicit-any` in `apps/api/src/payments/top-up-integration.module.ts`, `no-console` and `no-unsafe-finally` in `scripts/testing/w402-enqueue-smoke.mjs`, and an `exhaustive-deps` warning in `apps/admin/src/app/billing/page.tsx`. The notifications remain drafts because no direct agent-messaging channel was available; no owner was silently assigned or edited.

## 8. Failures, warnings and deferred work

- The first customer pause attempt exposed the missing web proxy allowlist entries; it was fixed and the pause was rerun successfully. The failed attempt is not hidden.
- The first enqueue attempt exposed a URL-based BullMQ connection using `6379`; it was fixed to reuse the isolated Redis connection. A Prisma composite-key error was also corrected before the successful run.
- Several enqueue wrapper commands printed valid JSON but surfaced PowerShell pipeline exit code `1`; the resulting authoritative state and counters were independently verified with `w601b-state-snapshot.mjs`.
- The probe was stopped and replaced twice for restart evidence. The first replacement was terminated by a short harness timeout; it was restarted with a longer timeout. The final probe is running as PID `4752`.
- Admin mobile screenshot shows horizontal overflow (`documentElement.scrollWidth 494` vs `clientWidth 390`). The customer mobile views had no overflow. This presentation issue is reported, not fixed as part of W6-01B.
- Spending-cap restrictions remain deferred: no cap exists in schema, API or UI, and no amount/policy was invented. The isolated reserve is evidence only.
- Emergency-stop recovery remains unimplemented. `docs/w6-01b-emergency-stop-recovery-design.md` is a proposal only; no marker clearing, re-enable button, production migration or policy decision was made.
- Migration approval, manifest entry, rollback policy, stale-`HELD` recovery, approved tariff/reserve, historical `COMPLETED` dispatch semantics, direct organizations FK and `campaigns_dispatch_state_idx` schema drift remain owner decisions in `docs/w6-01b-migration-review-handoff.md`.
- Product specification §11 and §31 were unavailable; no entitlement or billing rule was inferred from them.
- All changes remain uncommitted and unpushed. The isolated web, API, admin, Redis, PostgreSQL and final probe processes were left running for owner inspection.

## 9. Production-readiness statement

**W6-01 is not production-ready.** The isolated browser acceptance passed the requested customer and Platform Admin reliability checks, but it does not approve the W6-01 migration, the reviewed-migrations manifest, an emergency-stop recovery design, a production cost/reserve policy, or deployment. Emergency-stopped campaigns remain terminal, previously initiated calls are reconciled rather than replayed, and no new paid provider work was observed after stop, cancel or insufficient-balance guards.
