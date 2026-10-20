# RBAC-004 + RBAC-007 migration approval proposal

This is a review proposal only. It does not authorize production migration or deployment.

## Fail-fast lock policy

The controlled deployment wrapper adds PostgreSQL startup option `-c lock_timeout=5s` to the Prisma migration connection. Prisma documents PostgreSQL URL `options`; PostgreSQL applies the option at connection start. If a lock cannot be acquired within five seconds, the migration command fails and deployment leaves the active application release unchanged. Operators must inspect activity and retry only after the blocking transaction is understood; do not terminate unrelated sessions to force progress. An existing `options` setting that already includes `lock_timeout` is rejected for explicit review rather than silently replaced.

The migration CI job uses the same startup option on disposable PostgreSQL. The RBAC-007 rehearsal holds a conflicting table lock, confirms the migration fails within the timeout, verifies the transactional DDL left no marker column behind, releases the lock, and retries the exact SQL. The rehearsal uses only its fixed-name CI disposable database.

## Migration impact and recovery limits

RBAC-004 creates billing tables and constraints transactionally and does not backfill existing rows. Once billing ledger data exists, dropping these tables is lossy; there is no safe automatic down migration. Payment collection and wallet settlement remain disabled.

RBAC-007 adds a nullable campaign emergency-stop marker and guard triggers in one transaction without rewriting campaign rows. The existing enum remains unchanged. If a campaign has been emergency-stopped, reverting the database behavior could permit an unsafe restart; rollback must preserve the stop state and requires a reviewed forward fix.

Before production approval, require a verified encrypted backup restored into isolated PostgreSQL, exact production migration checksums and ledger review, passing exact-main CI, manual-only deployment gate activation, and explicit acceptance of recovery risk. R2 and recurring backups are deferred.

## Production smoke test and release sequence

Use only operator-authorized, existing accounts. Do not create accounts, reset passwords, or use customer records. First GET `/health` and confirm the response version equals the approved main SHA and PostgreSQL/Redis are up.

If an existing BILLING account is available, read only its own organization?s `GET /organizations/{organizationId}/wallet`, `/wallet/transactions`, and `/billing`; do not call `PATCH /billing` or `POST /wallet/top-ups`. If no account is available, do not provision one; record that authenticated billing allow-path is unverified.

If an existing VIEWER account is available, read only its own organization?s `GET /organizations/{organizationId}/campaigns` and `/reports/campaign-status`. Confirm cross-tenant reads and campaign create/update/delete requests are denied before any handler changes data. If no account is available, do not provision one; record the authenticated tenant-boundary test as unverified. Unauthenticated requests should return 401.

For Operations Admin, read `GET /platform/operations/me`, `/organizations`, `/campaigns`, and `/health` only when an authorized existing platform account is available. A non-platform account or unauthenticated request to platform operations must be denied. Do not call the production emergency-stop POST: it changes durable campaign state. Its allow-path and audit event are covered in disposable CI/staging; production only gets a deny-path request from a known non-Operations-Admin account, if one is available. If role accounts are unavailable, no production account or data is created to fill that gap.

Merge order: (1) after review, merge gate PR #31 and verify the workflow on main has only `workflow_dispatch`, false-by-default `authorize_production`, and exact-main successful CI enforcement; (2) complete the verified encrypted backup and isolated restore, then capture the production migration ledger and full checksums; (3) obtain explicit acceptance of post-commit recovery limitations and only then approve/merge this manifest proposal; (4) verify successful CI for the resulting exact main SHA; (5) dispatch production deployment with `authorize_production=true` only after final release approval. If any preflight differs from the reviewed evidence, stop.
