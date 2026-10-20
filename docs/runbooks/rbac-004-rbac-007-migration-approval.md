# RBAC-004 + RBAC-007 migration approval proposal

This is a review proposal only. It does not authorize production migration or deployment.

## Fail-fast lock policy

The controlled deployment wrapper adds PostgreSQL startup option `-c lock_timeout=5s` to the Prisma migration connection. Prisma documents PostgreSQL URL `options`; PostgreSQL applies the option at connection start. If a lock cannot be acquired within five seconds, the migration command fails and deployment leaves the active application release unchanged. Operators must inspect activity and retry only after the blocking transaction is understood; do not terminate unrelated sessions to force progress. An existing `options` setting that already includes `lock_timeout` is rejected for explicit review rather than silently replaced.

The migration CI job uses the same startup option on disposable PostgreSQL. The RBAC-007 rehearsal holds a conflicting table lock, confirms the migration fails within the timeout, verifies the transactional DDL left no marker column behind, releases the lock, and retries the exact SQL. The rehearsal uses only its fixed-name CI disposable database.

## Migration impact and recovery limits

RBAC-004 creates billing tables and constraints transactionally and does not backfill existing rows. Once billing ledger data exists, dropping these tables is lossy; there is no safe automatic down migration. Payment collection and wallet settlement remain disabled.

RBAC-007 adds a nullable campaign emergency-stop marker and guard triggers in one transaction without rewriting campaign rows. The existing enum remains unchanged. If a campaign has been emergency-stopped, reverting the database behavior could permit an unsafe restart; rollback must preserve the stop state and requires a reviewed forward fix.

Before production approval, require a verified encrypted backup restored into isolated PostgreSQL, exact production migration checksums and ledger review, passing exact-main CI, manual-only deployment gate activation, and explicit acceptance of recovery risk. R2 and recurring backups are deferred.
