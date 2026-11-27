# W5-03D — Customer analytics frontend implementation report

**Date:** 2026-11-24  
**Status:** Implemented and verified by automated checks. W5-03E paired-browser acceptance is still pending, so W5-03 as a whole remains **PARTIAL**.

## 1. Scope

W5-03D adds the customer-facing analytics UI over the six accepted, read-only W5-03C endpoints. It does not change the metrics engine, database adapter, reconciliation rules, CSV generator, backend controllers, provider adapters or any mutation path. No calls, payments, wallet operations, public callbacks, migrations, deployment, commits or pushes were performed.

The UI displays only values returned by the authenticated API. Money remains an exact integer minor-unit string and is formatted with `BigInt`; no floating-point conversion occurs. “Answered” is explicitly labelled as a current-state count (`ANSWERED` or `COMPLETED`) and never as a provider answer rate. No answer-rate denominator or §7 compliance claim is invented.

## 2. Files created

- `apps/web/src/lib/analytics.ts`
- `apps/web/src/lib/analytics.spec.ts`
- `apps/web/src/app/app/reports/analytics-dashboard.tsx`
- `apps/web/src/app/app/reports/analytics-dashboard.spec.tsx`
- `apps/web/src/app/app/reports/analytics-parts.tsx`
- `apps/web/src/app/app/reports/call-logs.tsx`
- `apps/web/src/app/app/campaigns/campaign-analytics.tsx`
- `apps/web/src/app/app/campaigns/campaign-analytics.spec.tsx`
- `apps/web/src/app/app/analytics-summary-card.tsx`

## 3. Files changed

- `apps/web/src/app/api/[...path]/route.ts` — six exact, read-only analytics GET routes and CSV `content-disposition` forwarding.
- `apps/web/src/lib/proxy.spec.ts` — allowlist, refused-route and CSV attachment-header tests.
- `apps/web/src/app/app/reports/page.tsx` — hosts `AnalyticsDashboard`, keyed by organization.
- `apps/web/src/app/app/page.tsx` — compact live summary card and corrected analytics links/copy.
- `apps/web/src/app/app/campaigns/page.tsx` — threads `reporting:read` into the campaign workspace.
- `apps/web/src/app/app/campaigns/campaigns-workspace.tsx` — threads the reporting gate and keys campaign review by organization/campaign.
- `apps/web/src/app/app/campaigns/campaign-detail.tsx` — mounts campaign analytics only with `reporting:read`.
- `apps/web/src/app/app/campaigns/campaigns-workspace.spec.tsx` — supplies the new reporting prop.
- `apps/web/src/app/app/campaigns/read-only.spec.tsx` — updates the Reports-page expectation from “analytics unavailable” to the read-only analytics workspace (filter/export controls are present; campaign mutation controls are not).
- `apps/web/src/app/globals.css` — analytics filters, status grid, campaign/call-log tables, money styling and responsive rules.
- `docs/api/w5-03-analytics.md` — status now records frontend integration with browser acceptance pending.

## 4. Implemented behaviour

- **Dashboard** — compact summary card on `/app` linking to `/app/reports#call-analytics`, rendered only when the membership has `reporting:read`.
- **Reports workspace** — organization totals, per-campaign performance, ten-state breakdown and paginated call logs.
- **Filters** — inclusive `from`, exclusive `to`, repeated `campaignIds`, paired/ordered/bounded date validation, clear action and reset to page 1.
- **Campaign detail** — unfiltered campaign totals, breakdown and paginated campaign call logs, gated by `reporting:read`.
- **CSV** — real same-origin download of the API CSV bytes with the applied filters; proxy forwards the attachment header; 10,001+ rows surface the API's `export_too_large` error.
- **Failure and empty states** — distinct messages for 401, 403, 404, 409, 413 and network/generic errors. 409 and import/export failures clear all displayed figures; no stale or partial metrics are substituted. Actual zero results are labelled as empty API results, not failed reconciliation.
- **Tenant isolation** — all paths include the authenticated organization ID; no client-supplied `organizationId` query is trusted; components are keyed by organization/campaign so switching scope cannot retain previous figures.
- **No fabricated fields** — call logs show campaign, attempt ID, current state, answered flag and exact customer charge. The API exposes no attempt timestamps or contact details, so none are displayed.

## 5. Automated verification

| Command | Result |
| --- | --- |
| `npm.cmd run lint --workspace @truevine/web` | Passed |
| `npm.cmd run typecheck --workspace @truevine/web` | Passed |
| `npx.cmd vitest run --no-file-parallelism --maxWorkers=1 src/lib/analytics.spec.ts src/app/app/reports/analytics-dashboard.spec.tsx src/app/app/campaigns/campaign-analytics.spec.tsx src/lib/proxy.spec.ts src/app/app/campaigns/campaigns-workspace.spec.tsx` | Passed: 5 files, 156 tests |
| `npm.cmd run test --workspace @truevine/web` | Passed: 33 files, 415 tests |
| `npm.cmd run build --workspace @truevine/web` | Passed; all 23 static pages generated |

The focused run initially hit Vitest fork-worker startup timeouts while `tsc` was running concurrently; rerunning sequentially produced clean results. No test was skipped or weakened to hide a failure.

`git diff --check` is clean for the W5-03D paths, apart from Git's LF→CRLF normalization warning on `apps/web/src/app/globals.css`. A broader check across `apps/web` reported trailing whitespace in `apps/web/src/app/app/campaigns/campaign-builder.tsx`; that file has concurrent uncommitted work and was not edited for W5-03D.

## 6. Review of four skipped API tests

Reviewed `apps/api/src/payments/top-up-payment-e2e.spec.ts` **without modifying or enabling it**. The whole suite is gated by `describe.skipIf(!_E2E_ENABLED)`, requiring `W502_E2E_ENABLED=true` and `W502_E2E_DATABASE_URL`. Its own guard rejects the `truevine_voice` database and permits only `truevine_w402_integration_test` or `truevine_payment_e2e`.

1. `creates a top-up request and payment intent in the same organization` — asserts atomic creation, organization match, `10000` minor units, UGX, `PENDING` status and the synthetic provider reference.
2. `does not create duplicate payment intents for repeated top-up requests` — repeats the same idempotency key and asserts exactly one stored intent.
3. `credits exactly once on successful synthetic settlement` — signs a synthetic callback, expects `CREDITED`, and asserts one wallet-credit row with the exact amount and reference.
4. `rejects cross-tenant intent status reads` — asserts a foreign organization cannot read the intent (`null`) while the owning organization sees `PENDING`.

These are W5-02 payment-isolation tests, not W5-03 analytics tests. They remain skipped because no approved isolated payment E2E database URL was supplied for this task. Their skip state is unchanged.

## 7. Shared-file coordination

A pre-edit baseline was saved at `C:\Users\ntaph\AppData\Local\Temp\opencode\w5-03d-shared-baseline.diff`. A post-edit comparison of the five files present in that baseline shows only the analytics additions: proxy allowlist/header forwarding, proxy tests, campaign-detail reporting gate/copy, and index/hunk shifts. `AppNavigation.tsx` and `AppNavigation.spec.tsx` were not edited. Other files with concurrent uncommitted work were re-read immediately before each narrow edit.

## 8. Deferred

- W5-03E paired-Chrome acceptance and screenshots (separate report).
- Final dashboard layout and export-column approval pending specification §7.
- Answer-rate denominator: not defined by the available API contract, deliberately not invented.
- No real call, payment, wallet mutation, provider callback, production migration or deployment.
