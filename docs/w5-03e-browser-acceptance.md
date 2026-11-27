# W5-03E — Paired-browser acceptance record

**Date:** 2026-11-24
**W5-03D:** accepted and verified earlier; unchanged by this acceptance pass except for the proxy query-string fix recorded below.
**W5-03E:** **PASSED** — all paired-Chrome acceptance checks below have explicit evidence.
**W5-03 as a whole:** not marked complete. Specification §7 was unavailable for this task, so final dashboard layout approval, export-column approval and answer-rate denominator remain unresolved product decisions. No §7 compliance claim and no answer rate are displayed anywhere in the UI.

## 1. Isolated environment

| Resource | Value |
| --- | --- |
| Web | `http://localhost:3100` (W5-03E-only Next.js dev server, PID 22344, parent PID 15160) |
| API | `http://localhost:3101` (W5-03E-only, PID 21832) |
| PostgreSQL | database `truevine_w503e_qa`, all 30 migrations applied |
| Redis | container `truevine-w503e-redis`, `127.0.0.1:56381` |
| Browser | paired Chrome tab group `W5-03E acceptance`, primary tab `770458070` |
| Synthetic accounts | OWNER A `w503e-owner-a@example.invalid`, OWNER B `w503e-owner-b@example.invalid`, BILLING `w503e-billing@example.invalid` (no `reporting:read`) |
| Organizations | Org A `26c3e32b-8458-46ed-a272-47931f2b75bb`, Org B `f73269da-2b05-48b1-9b0d-5b8c1e7f5e51` |

Services on ports 3000/3001/3002, Redis 56379, `truevine-postgres`/`truevine-redis`, the existing worker and other worktrees were not touched. No real call, payment, wallet mutation, provider callback, production migration, commit or push occurred.

Independent API baseline evidence is in
`C:\Users\ntaph\AppData\Local\Temp\opencode\w503e-evidence\api-baseline-summary.json`.
Key baseline facts:

- Org A unfiltered: attempts `5`, answered `2`, spend `{ "amountMinor": "1000", "currency": "UGX" }`, `RECONCILED`, usage events `2`, ledger entries `3`.
- Org B unfiltered: attempts `1`, answered `1`, spend `{ "amountMinor": "9999", "currency": "UGX" }`.
- Filtered Jan/Alpha: attempts `4`, answered `1`, spend `1000`; CSV SHA-256 `a26088dfe64eec8f3a61646bcf989965b1553f85b59c7c2683e467fd858ba508`.
- Expected statuses: unauthenticated `401 unauthenticated`; BILLING/cross-tenant `403 permission_denied`; foreign/unknown campaign `404 analytics_campaign_not_found`; invalid range `400 invalid_request`.

## 2. Explicit pass/fail checklist

### Desktop

| Check | Result | Evidence |
| --- | --- | --- |
| Dashboard summary card appears only with `reporting:read`; values match the summary API exactly | **PASS** | OWNER A dashboard showed attempts `5`, answered `2`, spend `UGX 1,000`, reconciliation `RECONCILED`, `2` usage events and `3` ledger entries. BILLING dashboard had `analyticsCards: 0` and no analytics card: `screenshots/dashboard-org-a.png`, `screenshots/dashboard-billing-no-card.png`. |
| `/app/reports` shows organization totals, ten-state breakdown, campaign performance and paginated call logs from the API | **PASS** | OWNER A reports page showed exactly the API totals and five call rows with pager `Showing 1–5 of 5`: `screenshots/reports-org-a-unfiltered.png`. |
| Date and campaign filters change all three report requests and the CSV request identically | **PASS** | Applied From `2026-01-01T00:00`, To `2026-02-01T00:00`, campaign Alpha. All four captured requests carried `from=2025-12-31T21%3A00%3A00.000Z&to=2026-01-31T21%3A00%3A00.000Z&campaignIds=81be3e1f-5939-40ce-8ca3-c03b3467947e`. `screenshots/reports-org-a-filtered.png`, `browser-filtered-network.json`. This verifies the proxy fix in `apps/web/src/app/api/[...path]/route.ts`. |
| Campaign detail shows the same unfiltered campaign totals and call log rows as the organization campaign report | **PASS** | Alpha detail showed attempts `4`, answered `1`, completed `1`, failed `1`, spend `UGX 1,000` and four call rows. Network bodies for `/analytics/campaigns/<id>` and `/analytics/campaigns/<id>/calls` matched the stored baseline: `screenshots/campaign-detail-alpha-org-a.png`. |
| CSV downloads as a real attachment, contains only applied filters, and preserves exact monetary strings and formula-injection protection | **PASS** | Clicking **Download CSV** produced a real browser download with `Content-Disposition: attachment; filename="analytics-calls.csv"`. File SHA-256 `a26088dfe64eec8f3a61646bcf989965b1553f85b59c7c2683e467fd858ba508` matched the API baseline; 4 rows, all Alpha, spend sum `1000` minor units, currency `UGX`, no cells beginning `=`, `+`, `-` or `@`: `browser-filtered-download.csv`, `browser-filtered-csv-verification.json`, `browser-filtered-network.json`. |
| Organization switch clears previous figures; foreign/unknown campaign shows 404-safe messaging | **PASS** | OWNER A was given a synthetic VIEWER membership in Org B in the isolated QA database, then the **Switch organization** combobox was used. Switching A → B replaced dashboard figures with attempts `1`, answered `1`, spend `UGX 9,999`, no Alpha/Beta text, and only Org B analytics requests; switching back to A and reopening `/app/reports` reset both date inputs to empty and restored attempts `5`/spend `UGX 1,000` with no Gamma text: `screenshots/reports-org-switch-clear-stale.png`. The API baseline confirmed a real cross-tenant/foreign campaign `404 analytics_campaign_not_found`; the browser 404-safe notice was exercised with a temporary page-level fetch override and showed “This campaign could not be found in the selected organization.” with zero metric cards and zero call rows: `screenshots/campaign-detail-404-safe.png`. |
| 401, 403, 409, 413, network, loading and actual-empty states each show the intended notice without invented metrics | **PASS** | See the state table in §3. |
| No call attempt timestamps, contact details or provider payloads are shown | **PASS** | DOM text and full-page screenshots show only campaign name, synthetic attempt UUID, current state, answered flag and exact charge. No timestamps, destinations, contact PII or provider fields appear. |

### Mobile / responsive

| Check | Result | Evidence |
| --- | --- | --- |
| Filters, metric cards, status grid, tables and pagination remain readable and horizontally scrollable where needed | **PASS** | At emulated `390 × 844` mobile viewport, reports `documentScrollWidth === documentClientWidth === 390`; both report tables had `clientWidth 323`, `scrollWidth 864`, `scrollable true`; filters were visible and pager read `Showing 1–5 of 5 / Previous / Page 1 of 1 / Next`: `screenshots/reports-mobile.png`. |
| Dashboard link and campaign-detail analytics remain reachable without overflow | **PASS** | Dashboard mobile card rendered attempts `5`/answered `2`/spend `UGX 1,000` with `documentScrollWidth === documentClientWidth === 390`. Campaign Alpha detail opened successfully on mobile, showed analytics, and had no document overflow: `screenshots/dashboard-mobile.png`, `screenshots/campaign-detail-mobile.png`. |

### Reconciliation

| Check | Result | Evidence |
| --- | --- | --- |
| Attempts, answered counts, current-state counts and exact spend match the API and PostgreSQL ledger/usage evidence | **PASS** | Dashboard and reports figures matched `api-baseline-summary.json` for both organizations; campaign and filtered figures matched their baselines; reconciliation status `RECONCILED` with usage/ledger counts displayed only where the API returned them. |
| No answer rate, denominator or §7 compliance claim is displayed | **PASS** | UI text states: “Answered” counts attempts currently in `ANSWERED` or `COMPLETED`; it is not a provider answer rate; no answer-rate denominator is defined by the available contract. No §7 wording or compliance badge appears anywhere. |

## 3. Error, loading and empty-state evidence

| State | Real or simulated in browser | Result and evidence |
| --- | --- | --- |
| `401 unauthenticated` | Real browser redirect from signed-out `/app/reports`; API baseline contains real `401` | Passed: navigation to `/app/reports` redirected to `/sign-in`; screenshot `screenshots/reports-unauthenticated-401.png`. |
| `403 permission_denied` | Real BILLING session | Passed: dashboard hid the analytics card; `/app/reports` showed “You do not have reporting access in this organization.”; a direct browser fetch of `/api/organizations/<org-a>/analytics/summary` returned `403 permission_denied`; UI network capture contained no analytics reads. Screenshots `screenshots/dashboard-billing-no-card.png`, `screenshots/reports-billing-403.png`. |
| `404 analytics_campaign_not_found` | Real cross-tenant API baseline; browser UI state simulated with a temporary fetch override | Passed: browser showed the not-found notice, zero metrics and zero call rows; screenshot `screenshots/campaign-detail-404-safe.png`. No ledger or campaign data was modified. |
| `409` reconciliation conflict | Simulated only — a real conflict would require corrupting authoritative evidence, which is prohibited | Passed: notice “Analytics could not be reconciled with the immutable ledger. No figures are shown.”; zero metric cards, zero status cells, zero call rows; screenshot `screenshots/reports-409-conflict.png`. |
| `413` oversized export | Simulated only — synthetic data has 5 rows, far below the 10,000-row cap | Passed: notice “The export contains more than 10,000 rows. Narrow the filters and try again.”; zero metric cards and zero call rows; screenshot `screenshots/reports-413-export.png`. |
| Network failure | Simulated by rejecting analytics `fetch` in the page | Passed: notice “Something went wrong. Please try again.”; zero metric cards and zero call rows; screenshot `screenshots/reports-network-failure.png`. |
| Loading | Simulated by delaying analytics `fetch` in the page | Passed: `role=status` “Loading analytics…” appeared while requests were pending; after completion the real 5-row result returned and no placeholder metrics were shown; screenshot `screenshots/reports-loading-state.png`. |
| Actual empty result | Real API query with future date range `2030-01-01` to `2030-02-01` | Passed: API returned genuine zero totals; UI showed “No call attempts yet / No attempts match the current filters. These zeros are the actual empty result returned by the API, not a replacement for a failed reconciliation.”; screenshot `screenshots/reports-empty-future-range.png`. |

Each temporary `fetch` override was installed only in the paired Chrome page, kept in memory, reset to `off` immediately after the check, and disappeared on the next full navigation. No source code, API response or database row was changed to simulate an error.

## 4. Evidence index

All paths are under `C:\Users\ntaph\AppData\Local\Temp\opencode\w503e-evidence\`:

- `api-baseline-summary.json` — independently computed API totals, statuses and CSV hashes.
- `browser-filtered-network.json` — compact captured request/response evidence for the three filtered reads and the real CSV download.
- `browser-filtered-download.csv` — exact bytes of the real browser CSV download.
- `browser-filtered-csv-verification.json` — hash, header, row count, exact minor-unit sum, currency and formula-prefix verification.
- `screenshots/dashboard-org-a.png`
- `screenshots/reports-org-a-unfiltered.png`
- `screenshots/reports-org-a-filtered.png`
- `screenshots/campaign-detail-alpha-org-a.png`
- `screenshots/reports-org-switch-clear-stale.png`
- `screenshots/dashboard-billing-no-card.png`
- `screenshots/reports-billing-403.png`
- `screenshots/reports-unauthenticated-401.png`
- `screenshots/campaign-detail-404-safe.png`
- `screenshots/reports-409-conflict.png`
- `screenshots/reports-413-export.png`
- `screenshots/reports-network-failure.png`
- `screenshots/reports-loading-state.png`
- `screenshots/reports-empty-future-range.png`
- `screenshots/reports-mobile.png`
- `screenshots/dashboard-mobile.png`
- `screenshots/campaign-detail-mobile.png`

## 5. Verification commands

| Command | Result |
| --- | --- |
| `npm.cmd run lint --workspace @truevine/web` | passed after the proxy fix |
| `npm.cmd run typecheck --workspace @truevine/web` | passed after the proxy fix |
| `npm.cmd exec -- vitest run src/lib/proxy.spec.ts` | passed — 131 tests, including the new query-string forwarding regression test |
| `npm.cmd test --workspace @truevine/web` | passed — 33 files, 416 tests |
| `npm.cmd run build --workspace @truevine/web` | passed — Next.js 16.4.5, TypeScript and static generation clean |

## 6. Acceptance statement

W5-03D remains accepted. Its implementation was previously verified, and the only subsequent change was the W5-03E proxy query-string fix plus its regression test.

W5-03E browser acceptance is **passed**: every checklist item above has an explicit pass result and paired-Chrome evidence. The UI displays only values returned by the six W5-03C analytics endpoints; money remains exact integer minor units; “Answered” is explicitly not an answer rate; no §7 compliance claim is made.

W5-03 is **not** marked complete in this record because §7-dependent product decisions are still open. The acceptance evidence does not resolve those product decisions and must not be read as doing so.
