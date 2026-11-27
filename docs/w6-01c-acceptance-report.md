# W6-01C acceptance and final report

Date: 2026-11-25

**Result: W6-01C assessment and the authorized Admin mobile overflow fix are complete. W6-01 is still not production-ready.** Emergency-stop recovery remains assessment-only; no recovery interface, permission, migration, marker clearing, restart or provider invocation was implemented.

## 1. Scope delivered

- Formal recovery decision paper comparing Options A/B/C, with Option A recorded only as a preferred MVP direction subject to owner approval: `docs/w6-01c-owner-decision-emergency-stop-recovery.md`.
- Held-reservation and financial reconciliation assessment: `docs/w6-01c-held-reservation-financial-assessment.md`.
- Migration readiness and database-owner handoff: `docs/w6-01c-migration-readiness-handoff.md`.
- Lint notification delivery status: `docs/w6-01c-lint-notification-status.md`.
- Narrow Admin operations-dashboard mobile fix in the authorized files, plus the supporting spec and minimal relevant CSS.
- Dedicated W6-01C isolation harness under `scripts/testing/w601c-*.mjs`; W5-03E and W6-01B stacks were not reused, stopped or restarted.

## 2. Emergency-stop findings

- `emergencyStoppedAt` is campaign-specific and tenant-scoped. Platform authorization is global; there is no platform-wide or organization-wide stop marker.
- Existing mechanisms are `SessionGuard`, `PlatformGuard`, `CsrfGuard`, `RequirePlatformPermission('platform:operations:write')`, `authorizeEmergencyWrite()`, the shared campaign advisory lock, and append-only sensitive audit `platform.campaign.emergency_stopped`.
- No recovery or re-enable route, permission, role, audit action, proxy entry, UI control, script or migration exists.
- ADR 0013 and ADR 0032 remain authoritative. The two-actor model is the preferred future authority model only after explicit owner approval.

## 3. Held reservation

The isolated `1000` synthetic UGX `HELD` reservation remains protected. It can leave `HELD` only on trusted `COMPLETED` usage settlement (`SETTLED`) or proof that provider invocation did not start (`RELEASED`). A timeout is not authoritative evidence. No TTL, sweeper, stale-`HELD` rule or timeout release was added. No wallet, ledger or reservation row was changed.

## 4. Migration handoff

A dedicated `truevine_w601c_qa` database was created on `127.0.0.1:55435`, with Redis on `127.0.0.1:56385`, API pin `3301`, a W6-01C queue and a fake provider. `prisma migrate deploy` applied 31 migrations to that isolated database only. `infrastructure/migrations-reviewed.json` was not changed by W6-01C and no production migration was applied. The nine readiness findings and owner decisions are recorded in the handoff document.

## 5. Admin mobile fix

Baseline from accepted W6-01B paired-Chrome evidence at 390px: `documentElement.scrollWidth 494`, `clientWidth 390`.

Root causes found in W6-01C measurement:

- The mobile header remained a row-flex sibling of the main panel, leaving the main panel only ~185px at 320px.
- `.health-grid` used `1fr`, whose automatic minimum let a card force ~198px.
- Reflowed table cells retained desktop percentage widths and lacked accessible row labels.

Fix applied without `overflow-x: hidden`:

- `platform-shell.css`: at <=768px the shell blocks, the mobile header is full-width with `min-width: 0`.
- `globals.css`: mobile health grid uses `minmax(0, 1fr)`; health cards have `min-width: 0`; operations shell, headers, search controls, tables, confirmation and button rows are bounded; reflowed table cells use full width and `data-label` labels.
- `operations-dashboard.tsx`: added `data-label` attributes to organization and campaign cells.

After-fix paired-Chrome presentation measurements in a dedicated isolated admin copy with a synthetic mock API (no real backend mutation):

| Width | `clientWidth` | `scrollWidth` | Result |
| --- | ---: | ---: | --- |
| 320 | 320 | 320 | Pass |
| 375 | 375 | 375 | Pass |
| 390 | 390 | 390 | Pass |
| 414 | 414 | 414 | Pass |
| 768 | 768 | 768 | Pass |
| Desktop 1280 | 1265 (scrollbar-adjusted) | 1265 | Pass |

At 390px, `Emergency stop` remained visible; the confirmation dialog measured left 32 / right 358 with `scrollWidth 325` / `clientWidth 325`, and both `Confirm emergency stop` and `Cancel` were present. The dialog was cancelled; no stop was performed. Screenshots and measurements are outside Git at `C:\Users\ntaph\AppData\Local\Temp\opencode\w601c-evidence\screenshots\`.

The temporary admin copy and mock API were removed after capture. W6-01B services and browser tabs were not reused.

## 6. Files created or changed by W6-01C

- `apps/admin/src/app/operations-dashboard.tsx`
- `apps/admin/src/app/operations-dashboard.spec.tsx`
- `apps/admin/src/app/globals.css`
- `apps/admin/src/app/platform-shell.css`
- `docs/w6-01c-owner-decision-emergency-stop-recovery.md`
- `docs/w6-01c-held-reservation-financial-assessment.md`
- `docs/w6-01c-migration-readiness-handoff.md`
- `docs/w6-01c-lint-notification-status.md`
- `docs/w6-01c-acceptance-report.md`
- `scripts/testing/w601c-isolated-env.mjs`
- `scripts/testing/w601c-provision-fixtures.mjs`
- `scripts/testing/w601c-api-bootstrap.mjs`

No other unrelated uncommitted change was edited. Nothing was committed, pushed or deployed.

## 7. Commands and verification

| Command | Outcome |
| --- | --- |
| Docker creation of `truevine-w601c-postgres` / `truevine-w601c-redis` and `CREATE DATABASE truevine_w601c_qa` | Passed. |
| `node scripts/testing/w601c-isolated-env.mjs node scripts/testing/w601c-provision-fixtures.mjs` with `W601C_MANIFEST_FILE` | Passed; 7 accounts and 4 campaigns. |
| `node scripts/testing/w601c-isolated-env.mjs npm run prisma:migrate:deploy` | Passed on isolated DB only; 31 migrations. |
| `npm.cmd exec --workspace @truevine/admin -- vitest run src/app/operations-dashboard.spec.tsx` | Passed after final CSS: 8/8 tests. |
| `npm.cmd run test --workspace @truevine/admin` | Passed: 21 files, 145 tests. An earlier run failed from worker-start timeouts and a test path issue; both were corrected before the final pass. |
| `npm.cmd run typecheck --workspace @truevine/admin` | Passed. |
| `npm.cmd run build --workspace @truevine/admin` | Passed. |
| Targeted ESLint on the two TSX files | Passed with no errors; CSS file ignored by config with a warning. |
| `npm.cmd run lint` | Failed with 8 pre-existing errors and 1 warning outside the W6-01C admin fix; see lint status doc. |
| Paired-Chrome emulation and screenshots at 320/375/390/414/768/desktop | Passed after final fix. |

## 8. Failures, warnings and constraints

- The W6-01B-derived API launcher initially failed on stale `apps/api/dist` (`PRINCIPAL` export mismatch), so the real W6-01C API was not used for the presentation pass. A synthetic mock API served only static platform-operations responses; no call, payment, stop, campaign mutation or ledger change occurred.
- The first attempt to start a second Next dev server from `apps/admin` was refused because W6-01B already held the workspace `.next` dev lock. The final measurement used a temporary copied admin directory, which was removed afterward.
- `npm.cmd run lint` remains red for unrelated pre-existing files. No rule was relaxed.
- Kilo Code and GitHub Copilot lint notifications were not delivered because no direct messaging tool or MCP resource exists.
- Product specification §11 and §31 were unavailable; no entitlement or billing rule was inferred.
- All W6-01/W6-01B/W6-01C changes remain uncommitted and unpushed.

## 9. Deferred work

Not implemented by design: emergency-stop recovery endpoints, permissions, roles, marker clearing, re-enable controls, recovery migrations, dispatch state transitions, automatic restarts, automatic provider calls, reservation release, stale-`HELD` reconciliation, tariff/spending-policy invention, provider activation, public callback activation, production migrations and deployment.

## 10. Production-readiness statement

**W6-01 is not production-ready.** The Admin overflow fix is complete and verified in an isolated presentation environment, but recovery remains unapproved and unimplemented, migration-manifest approval and owner decisions remain open, held-reservation reconciliation policy is unresolved, root lint is red, and no deployment authorization exists.
