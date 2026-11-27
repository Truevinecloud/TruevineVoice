# ADR 0030 W5-03 analytics metrics and CSV slice

Status: W5-03 unwired read-only slice implemented in new files and unit tests. No HTTP route, dashboard, call-log list UI, database read adapter, provider integration, migration or shared module wiring is included. The approved MVP specification §7 referenced by the workplan is unavailable in this repository; this ADR does not claim compliance with text that has not been read.

## Context

The W5-03 workplan row requires “Dashboard/call logs/export”, “Answer/status/spend/campaign detail/CSV”, and the acceptance evidence “Metrics reconcile with attempts/ledger”. It depends on W4 and references specification §7.

The repository currently has only campaign-record counts in the dashboard and status report. Call attempts, call events, callback receipts and append-only wallet/usage tables exist as write-side foundations from adjacent work, but there is no call-log read API, no answer/spend aggregation, no campaign-detail metrics, and no CSV export. The referenced §7 document is not present.

Ownership is constrained: campaign, call, billing, schema and module files have uncommitted work from other lanes, Kilo Code owns payment E2E and migration-approval worktrees, and the main worktree is on an RBAC branch. This change therefore stays in a new-files-only lane.

## Decision

Implement a pure, tenant-scoped analytics calculation and CSV serializer. Do not wire them into Nest, HTTP, PostgreSQL or the web UI.

1. `buildAnalyticsReport()` accepts an explicit organization ID plus organization-scoped call-attempt, voice-usage and wallet-ledger read models. Any record from a different organization fails with `TENANT_MISMATCH`.
2. Status counts come from the immutable `CallAttempt.state` values. The answer count is the number of attempts currently in `ANSWERED` or `COMPLETED`; this is a current-state proxy derived from the domain state machine, not a provider answer-rate claim.
3. Voice usage evidence carries only immutable customer charge, currency, debit entry, optional reversal credit entry and pricing identity supplied by a future adapter. Provider-reported amount/cost is not an input.
4. Spend is exact integer UGX minor units actually debited by voice usage and not later reversed. Money uses `@truevine/domain`'s `Money`; no float, JSON number, rounding or exchange rate is introduced.
5. Every charged usage event must match its wallet debit exactly, and every reversal must match its compensating credit exactly. Duplicate, orphaned, cross-currency or mismatched evidence fails closed. Unlinked ledger entries such as top-up credits are ignored for spend but still tenant-checked.
6. A report is returned only when usage evidence and the ledger agree. The report includes per-campaign summaries, per-attempt call-log rows and a `RECONCILED` marker with evidence counts.
7. `serializeAnalyticsCsv()` emits one row per attempt with exact decimal minor units, boolean answered state and one deterministic state indicator column per call state. Campaign and organization totals can be reproduced by summing the rows.
8. No new table, column, index, migration or approval-manifest entry is added. No real call, payment, customer charge, public callback, campaign dispatch, service restart or main-database write is performed.

## Testing

- `analytics-metrics.spec.ts` proves aggregation, reversed-charge exclusion, tenant mismatch, duplicate records, orphan usage, ledger mismatch, unexplained reversal credit, mixed currency and unknown states.
- `analytics-csv.spec.ts` proves the deterministic header, exact integer money, boolean answered field, state indicators and CSV escaping.
- Tests are pure unit tests with in-memory read models; they require neither PostgreSQL nor Redis and use no live tariff, provider response or customer data.

## Alternatives considered

- **Wire an HTTP endpoint and web dashboard now:** rejected because shared controllers, modules, app wiring and UI files have concurrent uncommitted work and §7 is unavailable.
- **Read provider cost as spend:** rejected by ADR 0027 and ADR 0028; provider cost is evidence and never the customer charge.
- **Compute spend from the whole wallet balance:** rejected by ADR 0012; top-ups and adjustments are not voice spend.
- **Add an analytics table or denormalized counters:** rejected because no migration is approved and the acceptance criterion requires reconciliation with the existing attempts/ledger sources.
- **Report a discrepancy instead of failing:** rejected for this slice; an unreconciled report could be mistaken for accepted W5-03 evidence.

## Consequences

- A testable contract now exists for deriving answer/status/spend/campaign/CSV output without inventing financial or operational policy.
- Full W5-03 acceptance is not claimed. A future owner must add organization-scoped PostgreSQL read adapters, an authorized HTTP route, dashboard/call-log/campaign-detail UI and isolated database verification, then prove the same reconciliation against the real tables.
- Answer semantics remain limited to current attempt state. Event-level answer evidence and answer-rate denominator policy require an approved specification before being added.
- The referenced MVP specification §7 remains an explicit blocker for product-level dashboard layout, export columns and any metric definition not stated in the workplan or existing ADRs.
