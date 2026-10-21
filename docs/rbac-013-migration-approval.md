# RBAC-013 production migration approval

Status: approval proposal for review; production migration has not run.
Implementation PR #45 merged at 57ffdf5fe403c238a5064d9b4de8c10c04def066.
Current production code baseline: 5b5f1b00f4d18af3d9d890ebf6577d7b47317430.

This record and the matching manifest entry propose allowing the reviewed release
to contain migration 20261021150000_sensitive_audit_integrity. Merging this
approval change permits the controlled deployment workflow to attempt it; it
does not apply SQL or itself authorize a production dispatch.

## SQL review

Canonical migration SQL SHA-256:
7b71c0e2e282bfbe04e057a7382906a366445285451bd201b1800aea489bae1f.

The migration wraps two CREATE TRIGGER statements in BEGIN/COMMIT. It adds
BEFORE TRUNCATE statement triggers to security_audit_events and
identity_audit_events, invoking their existing append-only trigger function.
It has no data rewrite, backfill, table/column/enum change, DROP, or edit to
previously applied SQL. The existing application does not truncate these tables.
Application code already blocks row UPDATE/DELETE. Ordinary future TRUNCATE
attempts fail; database owners and superusers can still change DDL.

Prisma cannot represent custom PostgreSQL triggers. The SQL is reviewed directly,
and the disposable PostgreSQL CI run applied it along the complete migration
chain. Migration rehearsal passed. The deployment executor uses a five-second
PostgreSQL lock timeout for each wait; that does not bound total SQL/lock holding
time. The DDL requires table locks, so production activity must be inspected
during the supervised migration and the run stopped for unexpected blocking.
The migration is additive and transaction-wrapped. Code rollback retains it;
there is no destructive down migration. If migration status is ambiguous or it
fails, stop and inspect privately; do not resolve/reset or edit SQL.

## Recovery evidence and limitations

The administrator-reported local archive was verified on production VPS
vmi3644538 on 2026-10-21:

- /var/backups/truevinevoice/truevine_voice_20261021T112843Z.dump
- Created 2026-10-21 11:28:43 UTC; 58,414 bytes.
- SHA-256 307b2c0cb5bbbd30ebd286f5a02417f7fdd0db00c773ea13f707dc22738261a6.
- PostgreSQL 18.6 / postgres:18-alpine; archive catalog 128 entries.
- Checksum verification, isolated pg_restore, volume persistence after
  recreation and identical before/after schema fingerprints all passed.
- Restored 16 public tables / 13 applied Prisma migrations; disposable resources
  were removed. Production PostgreSQL and Redis remained unchanged.

This is the existing recovery evidence recorded in
[PR #42's recovery approval review](pr42-call-persistence-migration-approval.md).
It proves that specific archive can be restored and the local recovery procedure
works. It is a point-in-time archive from before call-persistence migration
20261021120000_call_persistence; current production therefore contains a later
migration ledger and schema. The restore rehearsal did not independently replay
the intervening call-persistence migration onto that restored archive. CI has
applied all migrations from an empty disposable database, not performed that
archive-plus-forward-migrations recovery rehearsal. No claim is made that the
archive is a current-data backup or reproduces today's production exactly.

For this migration, no business rows or existing schema objects are changed; the
two target audit tables and trigger function existed in the 13-migration archive.
An application rollback leaves only the two protective triggers. The archive is
the only verified local recovery point documented here; production has no
point-in-time recovery or automated backups. Any restore over production remains
a separate supervised operation. Do not overwrite production as part of this
deployment.

The deployment approval runbook requires SQL review, backward compatibility,
a rehearsed backup and a recovery plan. The evidence above satisfies that
documented baseline, with its freshness and restore-forward limitations explicitly
disclosed for the release approver. The production operator must privately inspect
the current database, available disk space and activity immediately before the
manual workflow dispatch. If the approver requires a fresh archive or a
restore-plus-forward rehearsal because the existing point predates PR #42's
migration, the release remains blocked until an administrator completes that
minimum recovery verification using existing local resources.

## Release conditions

- This proposal is based on merged main commit
  57ffdf5fe403c238a5064d9b4de8c10c04def066; the main push CI run passed.
- The approval PR must pass required CI and receive normal human review.
- The manifest contains every migration directory exactly once after this update.
- No production migration/deployment has occurred from this approval change.
- After approval merge, wait for successful push CI for the exact new main SHA.
- Only then can the separately authorized manual workflow dispatch proceed,
  with authorize_production=true, using the documented exact-SHA and
  environment gates. Stop if production environment approval, SSH, DB,
  migration, locking, or health checks fail.
- After deployment verify live SHA, Prisma migration status, exactly 15
  successful migrations including this exact migration, API health with
  PostgreSQL/Redis up, and public web/API health. Do not place calls or charge.

No new infrastructure, off-site backup, production data edit, direct SQL,
merge bypass, or automatic deployment is part of this proposal.
