# RBAC-007 — Platform Operations Admin

**Status: implemented locally; database E2E and release approval remain pending.**

## Baseline and RBAC-006 evidence

The active production API `/health` reported
`4da51ffb948f0d96311b40edd42515441e2b9121`; GitHub's latest successful
Production deployment run was #34 ([39236484211](https://github.com/Truevinecloud/TruevineVoice/actions/runs/39236484211))
at that same SHA. The new branch `feat/rbac-007-operations-admin` is based on
that release in a separate clean worktree.

No RBAC-006 implementation or workplan was found in checked local commits,
branches, PRs, documentation or remote branch/PR metadata. The platform
authorization foundation predates this task: `OPERATIONS_ADMIN` and its
four-permission registry are in the production baseline, alongside
`PlatformGuard`, platform-role assignments, and separate organization roles.
That is authorization scaffolding, not a completed RBAC-006 feature.

The approved RBAC tracker was not present in the repository, and no connected
tracker was available to inspect or update. Implementation follows the scope
provided in the task.

## Implemented

- Added platform-only API routes for operator context, organization operational
  status, the latest 100 campaigns, and API/PostgreSQL/Redis health.
- Added the Operations page in the platform-admin app with its own sign-in
  form, server-side allowlisted same-origin API proxy, service health cards,
  organization and campaign tables, and an emergency-stop control.
- Added a persistent emergency-stop timestamp. The database keeps the existing
  COMPLETED enum value for compatibility; API reads present a marked record as
  PAUSED. A database trigger prevents older application code from clearing the
  marker, reactivating a stopped campaign or deleting its record.
- Writes the stop and a platform-scoped audit event atomically. Audit metadata
  stores one of five allowlisted reason codes.
- Kept billing, refunds, pricing, role assignment and platform-role management
  outside the Operations Admin interface and endpoints.

## Explicit capability gap

This production baseline has campaign records but no voice provider adapter,
call dispatch or active-call model. Operations health therefore reports
`voiceProvider.status = not_integrated`; campaign emergency stop reports
`voiceDispatchStopped = false`. It safely pauses the campaign record and blocks
re-activation through the customer API. It cannot terminate calls or dispatch
that the platform does not implement.

## Migration and deployment gates

Migration `20261020110000_rbac_007_emergency_stop` adds the marker column and
compatibility trigger. It is **not** listed in `infrastructure/migrations-reviewed.json`.
The PR CI migration rehearsal runs against disposable PostgreSQL; no production
migration or manifest approval is authorized by this task. PR #27's pending
RBAC-004 billing migration is timestamped earlier and uses independent tables,
but its current SQL does not declare an explicit transaction. It must be
reviewed/fixed and merged before a combined release; this branch does not change
that PR.

Before controlled deployment, require green CI (including the new real database
E2E suite), migration review and approval, and explicit provisioning of an
Operations Admin account through the already authorized operator process. Set
`TRUEVINE_API_URL` for the admin server. The admin site must be served on HTTPS
at the same origin as its API proxy so the secure session and CSRF cookies stay
host scoped. No new operator account or role assignment is provisioned by this
change. The repository has no supported platform-role provisioning command;
platform-role assignment is deliberately not exposed through this API or UI.
Before UAT, the authorized operator needs a separately reviewed provisioning
procedure. The supported organization role activation/invitation flow and the
Operations Admin provisioning gap are documented in
[`docs/runbooks/uat-account-provisioning.md`](./runbooks/uat-account-provisioning.md).
Do not create production role assignments with ad-hoc SQL.

## Verification to date

- `npm ci` — PASS; npm reported the repository's existing five high-severity
  development dependency advisories.
- `npm run prisma:generate`, `npm run prisma:validate` — PASS.
- `npm run lint` — PASS.
- `npm run typecheck` — PASS across workspaces.
- `npm test` — PASS, all unit and deployment checks; POSIX-only runtime checks
  are intentionally skipped on Windows by the existing scripts.
- Focused real PostgreSQL E2E — BLOCKED before database connection because this
  worktree has no `DATABASE_URL`, Docker CLI is unavailable, and no disposable
  PostgreSQL listener is running on 127.0.0.1:55432. The suite includes an
  allowlist check that refuses non-disposable database URLs.
- Production `GET /health` — PASS; reported SHA matches the latest successful
  protected deployment run as recorded above.
