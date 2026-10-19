# RBAC-005 — Customer Viewer / Analyst progress

**Assessment: PARTIAL.** The existing `VIEWER` role now has customer pages for its organization dashboard, campaign inventory, and a campaign status report. Campaign reads and report reads are separately guarded and tenant-scoped. The Viewer has no campaign, billing, wallet, organization, or membership write permissions. Real campaign execution outcomes and performance metrics do not exist in the current data model, so they are not reported and the overall task is not complete.

## Completed

- Reused the existing `VIEWER` role and its `organization:read`, `campaign:read`, and `reporting:read` permissions; added a regression assertion for the exact permission set.
- Added a read-only campaign inventory page showing existing campaign status and timestamps.
- Added `GET /organizations/:organizationId/reports/campaign-status`, guarded by `reporting:read`, with counts sourced only from campaigns in the authorized organization.
- Added a read-only reports page and permission-filtered navigation links.
- Added UI and service/HTTP/real-database E2E regression coverage for tenant scoping, report access, and 403 responses for campaign, billing, top-up, organization, and membership mutations.

## Verification

- `npm.cmd run lint` — PASS.
- `npm.cmd run prisma:validate` — PASS.
- `npm.cmd test` — PASS, 651 tests passed; 3 existing Windows-only skips.
- `npm.cmd run typecheck` — PASS.
- `npm.cmd run build` — PASS; includes `/app/campaigns` and `/app/reports`.
- `npm.cmd run format:check` — FAIL on 221 repository files, including untouched baseline files and `infrastructure/migrations-reviewed.json`; the manifest was not edited.
- `npm.cmd run test:e2e --workspace @truevine/api -- campaigns.e2e-spec.ts` — BLOCKED before test execution because Docker/psql are unavailable and `localhost:55432/truevine_voice` is not listening. Vitest reports 25 test cases unrun after the database setup failed; no production resource was accessed.

## Remaining acceptance work

- Campaign call execution and result records must be implemented before customer-visible call outcomes, delivery rates, or performance reports can be provided.
- Run the focused API E2E suite with a disposable local PostgreSQL database after infrastructure is available. No browser UAT or production verification was performed.
- No tracker spreadsheet exists in the repository, and no live tracker update was made.

**Suggested tracker comment:** “Viewer read-only dashboard, campaign inventory, and tenant-scoped status report are implemented locally. API and UI tests deny campaign, billing, top-up, organization, and membership changes. Campaign execution outcomes and performance analytics remain outstanding; real PostgreSQL E2E awaits disposable local infrastructure.”

No commit, push, merge, deployment, or production data operation was performed.
