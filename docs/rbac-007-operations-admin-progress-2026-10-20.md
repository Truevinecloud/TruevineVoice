# RBAC-007 — Platform Operations Admin

**Status: implemented, committed and pushed; PR #28 is open with all CI checks passing. Production migration approval and release remain pending.**

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
compatibility triggers. It is **not** listed in
`infrastructure/migrations-reviewed.json`. On disposable PostgreSQL, CI verified
the complete migration succeeds; a forced late error rolls back the DDL; retrying
the exact SQL succeeds; and legacy updates/deletes cannot restart or erase a
stopped campaign. No production migration or manifest approval is authorized by
this task.

PR #27's pending RBAC-004 billing migration is timestamped earlier and creates
independent tables, but its current SQL does not declare an explicit transaction.
It must be reviewed/fixed before a combined production release. RBAC-007 CI ran
against `main` without PR #27; integrate the branches in sequence and rerun CI
against the combined schema before release. The two branches also touch
`schema.prisma`, so resolve any integration conflict without rewriting history.

Before controlled deployment, require green combined CI (including the new real database
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

## Verification and publication

- Branch head: `a6d801cf273a335521748fc8f6b613c5e9b02dcd`.
- PR [#28](https://github.com/Truevinecloud/TruevineVoice/pull/28) is open and all checks pass. CI run [39368942753](https://github.com/Truevinecloud/TruevineVoice/actions/runs/39368942753) passed lint, typecheck, Prisma validation, unit tests, database-backed E2E, security remediation tests, and production build. Migration rehearsal run [39368942760](https://github.com/Truevinecloud/TruevineVoice/actions/runs/39368942760) and restore integration run [39368942864](https://github.com/Truevinecloud/TruevineVoice/actions/runs/39368942864) also passed.
- Local `npm run prisma:generate`, `npm run prisma:validate`, `npm run lint`, `npm run typecheck`, `npm test`, `npm run build`, and `git diff --check` passed. Windows skipped the existing POSIX-only backup/database-verification runtime checks; their required GitHub Linux CI checks passed.
- No deployment, merge, production data access, or migration manifest change was made. The original dirty development worktree remains separate and untouched.
