# RBAC-001 migration safety review

Reviewed against a live PostgreSQL instance on 2026-10-16. **Not approved for
production.** The review gate (`infrastructure/migrations-reviewed.json`) is
deliberately unchanged, so `deploy:release` still refuses this tree.

The execution claims below are inherited from the previous session and were not
repeated during final verification. The current development container is
PostgreSQL 18; the earlier PostgreSQL 16 claim is not independently confirmed.
No migrations were applied in the final-verification session.

Four migrations remain unapproved for production:

| Migration | Lines | Risk |
| --- | --- | --- |
| `20261016130500_identity_rbac_001` | 289 | **High** — destructive enum swap, `CREATE EXTENSION` |
| `20261016141500_identity_audit_events` | 76 | Low — additive table plus a trigger |
| `20261016142500_identity_audit_fk_restrict` | 35 | Low — one constraint replaced |
| `20261016153000_organization_suspension` | 38 | Low — one nullable column |

---

## 1. SQL correctness

All four apply cleanly to PostgreSQL 16 via `prisma migrate deploy`, and
`prisma validate` passes. Each migration carries an in-file header stating its
rollback and its prerequisites.

`identity_audit_events` and `identity_audit_fk_restrict` were verified against a
live database by asserting that `DELETE` and `UPDATE` on both audit tables are
refused by trigger, and that deleting a user with audit history fails on the
`RESTRICT` foreign key rather than cascading.

## 2. The destructive enum swap

`MembershipRole` changes from `OWNER|ADMIN|OPERATOR|VIEWER` to
`OWNER|ADMIN|CAMPAIGN_MANAGER|BILLING|VIEWER`. `OPERATOR` has no successor.

The swap uses the standard three-step pattern, wrapped in an explicit
transaction so a failure cannot leave the type half-renamed:

```sql
BEGIN;
CREATE TYPE "MembershipRole_new" AS ENUM (...);
ALTER TABLE "invitations"  ALTER COLUMN "role" TYPE "MembershipRole_new" USING ("role"::text::"MembershipRole_new");
ALTER TABLE "memberships" ALTER COLUMN "role" TYPE "MembershipRole_new" USING ("role"::text::"MembershipRole_new");
ALTER TYPE "MembershipRole"     RENAME TO "MembershipRole_old";
ALTER TYPE "MembershipRole_new" RENAME TO "MembershipRole";
DROP TYPE "public"."MembershipRole_old";
COMMIT;
```

**This migration is only safe while `memberships` and `invitations` are empty.**
That is true of the current line of development and false the moment a real
tenant exists. The `USING` clause has no mapping for `OPERATOR`, so a surviving
`OPERATOR` row aborts the whole transaction.

Verified rather than assumed — replayed the exact `ALTER TABLE ... USING` against
a table holding an `OPERATOR` row, in a rolled-back transaction:

```
ERROR:  invalid input value for enum "MembershipRole": "OPERATOR"
```

The development database now holds 102 memberships, all `OWNER`, and the live
enum carries only the five new labels. No `OPERATOR` row survives here. **This
must be re-verified against a staging database seeded to the target data volume
immediately before any production run**, because the safety condition is a
property of the data, not of the script.

## 3. Extension requirement

`citext` must exist before the `CITEXT` columns on `users.email` and
`invitations.email` are created. The migration runs
`CREATE EXTENSION IF NOT EXISTS citext` before them.

**The migration role must be able to create extensions.** Verified that a
non-superuser role cannot:

```
ERROR:  permission denied to create extension "citext"
HINT:  Must have CREATE privilege on current database to create this extension.
```

It succeeds here only because the development connection is a superuser. In an
environment where the migration role lacks this privilege, either pre-install
`citext` as a database owner or grant the privilege before deploying. This must
be settled **before** the migration is scheduled, not during it.

## 4. Execution order

Timestamps order the four migrations unambiguously, and each depends on the one
before it:

1. `identity_rbac_001` — creates `users`, the audit tables, `invitations`, and
   the foreign keys that later migrations rely on.
2. `identity_audit_events` — creates the identity-scoped audit table and requires
   `users` to exist.
3. `identity_audit_fk_restrict` — requires `identity_audit_events`; it replaces a
   `CASCADE` delete rule with `RESTRICT`.
4. `organization_suspension` — independent of the others but applied last.

The `ALTER TYPE` block sits **after** the table definitions in migration 1
deliberately: `invitations.role` references the type and did not exist when the
generated SQL was emitted.

## 5. Locking and downtime

- **Adding foreign keys** (`ALTER TABLE ... ADD CONSTRAINT ... REFERENCES`) takes
  a `SHARE ROW EXCLUSIVE` lock on the referencing table and a `ROW SHARE` lock on
  the referenced one. Reads and writes continue; concurrent writes **block**.
  On `memberships` — currently small, expected to stay modest — this is
  milliseconds.
- **Creating indexes without `CONCURRENTLY`** takes a `SHARE` lock, which permits
  reads and writes but blocks schema changes. Fine on empty or small tables; on
  a large populated `memberships` table, consider
  `CREATE INDEX CONCURRENTLY` in a separate migration, run outside a transaction.
- **`CREATE EXTENSION`** takes a brief exclusive lock.
- **`ALTER TYPE` with a table rewrite** takes `ACCESS EXCLUSIVE` on each table.
  This is the longest step and the reason the transaction is explicit.

Every step is metadata-only except the enum swap, which rewrites the affected
tables. **Estimated downtime: seconds, on a table this size.** If
`memberships` grows by orders of magnitude, re-measure before scheduling.

## 6. Rollback and recovery

Each migration documents its own rollback in a header comment. They are not
symmetrical:

- **Migration 1 rollback is lossy.** `DROP TABLE` removes the identity and audit
  tables; recreating them empty discards all audit history, which the
  append-only triggers were built to protect. A rollback of migration 1 should be
  treated as a last resort requiring explicit sign-off.
- **Migration 2 rollback** drops `identity_audit_events`, same caveat.
- **Migration 3 rollback** restores `ON DELETE CASCADE`, which would let a
  deleted user silently take their identity audit trail with them. **Do not roll
  this back** without deciding where that history should live; it is the
  migration that enforces immutability for identity events.
- **Migration 4 rollback** is `DROP COLUMN suspended_at`, safe while the column
  is unset. Once a suspension exists, dropping the column silently un-suspends an
  organization nobody reviewed. Treat as forward-only from the first suspension.

**Recovery if the deploy fails mid-run:** PostgreSQL wraps each migration in a
transaction, so a failure leaves the schema at the previous migration. `prisma
migrate deploy` reports the failed migration; resolve, then re-run.

## 7. Existing-data compatibility

Expand/contract, no renames or drops that the currently deployed application
depends on. The deployed application has no authentication code and reads neither
`users` nor the audit tables, so every migration is invisible to it. Additions
are nullable or have defaults, so the old code keeps working throughout.

## Recommendation

**Do not approve yet.** Three things must happen first:

1. Seed a staging database to the expected production data volume and re-run all
   four migrations there, confirming the enum swap succeeds and measuring the
   lock time.
2. Settle how `citext` gets installed in the target environment. This is an
   environment fact, not something the migration can decide for itself.
3. Decide what rollback means for migrations 1 and 2, given that rolling them
   back destroys audit history.

Once those three are done, listing the four directories in
`infrastructure/migrations-reviewed.json` permits the code to deploy. It does not
apply the migration: `prisma migrate deploy` remains an operator action from a
controlled environment.