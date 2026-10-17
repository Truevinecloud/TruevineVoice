# RBAC-001 staging rehearsal and production preflight

This runbook covers the two things standing between the merged RBAC-001 code and
applying its six migrations to production: proving they behave correctly on a
**disposable** database, and confirming production is in a state where they are
safe to apply.

It is deliberately separate from
[Production deployment](./production-deployment.md), which covers releasing
application code. Nothing here changes application code, and nothing here is a
migration.

> **The rehearsal never touches production.** It starts its own PostgreSQL
> container, named from a fresh run id and labelled `truevine.rbac.rehearsal.run`,
> published on `127.0.0.1` only, mounting only the volume it creates, populated
> with synthetic rows only. It removes every resource it created on exit.

The migrations under test are the seven listed in
`infrastructure/migrations-reviewed.json`:

| Order | Migration                                   | Notes                                                                                                                                       |
| ----- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | `20261014042915_tenancy_core`               | Pre-existing; assumes `organizations` and `memberships`.                                                                                    |
| 2     | `20261016130500_identity_rbac_001`          | `citext`; new tables; **destructive `MembershipRole` swap inside a mid-file `BEGIN;…COMMIT;`**, then indexes, foreign keys and a trigger.   |
| 3     | `20261016141500_identity_audit_events`      | Additive table, indexes, foreign key, append-only trigger.                                                                                  |
| 4     | `20261016142500_identity_audit_fk_restrict` | Swaps one foreign key to `ON DELETE RESTRICT`.                                                                                              |
| 5     | `20261016153000_organization_suspension`    | Adds `organizations.suspended_at` and a partial index.                                                                                      |
| 6     | `20261016170000_security_atomicity`         | Takes a lock; refuses ownerless / multi-owner organizations, inconsistent invitations and OWNER invitations; adds constraints and triggers. |
| 7     | `20261016171000_invitation_origin`          | Additive trigger; refuses an invitation author outside the organization.                                                                    |

## 1. The rehearsal harness

`infrastructure/scripts/rbac-001-rehearsal.sh` is executed by
`npm run test:rehearsal`. It needs Linux, a container runtime (`docker` or
`podman`) and `node_modules` (`npm ci`). On any other platform it skips with an
explanation; in CI a skip is a hard failure because the workflow sets
`REHEARSAL_REQUIRED=1`.

### Running it

CI: the `RBAC-001 rehearsal` workflow runs it on every pull request that touches
`packages/database/prisma/**` or the rehearsal scripts.

Locally, on Linux:

```bash
npm ci
REHEARSAL_REQUIRED=1 bash infrastructure/scripts/rbac-001-rehearsal.sh
```

The script starts PostgreSQL, runs every scenario below against it, prints a
`FINDINGS` section, and finishes with `RESULT: PASS` or `RESULT: FAIL`.

### Scenarios and what each one proves

| #   | Scenario                                               | Database state                                                                     | Expected                                                                                                                                                             |
| --- | ------------------------------------------------------ | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S1  | Fresh full deploy                                      | Empty                                                                              | All seven apply; `MembershipRole` becomes `OWNER,ADMIN,CAMPAIGN_MANAGER,BILLING,VIEWER`; every table, index, function and trigger exists; `users.email` is `citext`. |
| S2  | Populated valid database                               | 2 orgs, 2 users, 3 memberships, 1 invitation after migrations 1–4                  | Migrations 5–7 apply; **no row is lost or changed**; the ledger records seven clean applications.                                                                    |
| S3  | Adversarial: an `OPERATOR` membership                  | An org with a membership whose role is `OPERATOR`                                  | Migration 2 **fails**; the ledger records it failed; the enum swap does **not** apply. The exact error is often masked (see below).                                  |
| S4  | Adversarial: an ownerless organization                 | An org with no `OWNER`                                                             | Migration 6 **fails** with the owner-count refusal; `memberships_single_owner` is not created. The exact error is often masked (see below).                          |
| S5  | Adversarial: an `OWNER` invitation                     | A valid owner plus an invitation with `role = 'OWNER'`                             | Migration 6 **fails** with the invitation refusal; the check constraint is not added. The exact error is often masked (see below).                                   |
| S6  | Probe: failing 2-statement migration                   | Empty                                                                              | The migration fails; the harness **measures** whether its first statement survives, i.e. whether Prisma wraps a migration in a transaction on this version.          |
| S7  | Probe: failure inside an explicit `BEGIN;…COMMIT;`     | Empty                                                                              | The migration fails; the table created before the failing statement **must be absent** (the aborted transaction rolls back).                                         |
| S8  | Decisive: late failure in the real `identity_rbac_001` | Empty, then a statement **after** the file's mid-file `COMMIT` is injected to fail | The migration fails; the harness records whether the enum swap and tables survive — **the partial-application question**.                                            |

### What to do with the findings

S6 and S8 are **measurements, not pass/fail gates**. The harness passes as long
as each scenario behaved as described; the `FINDINGS` section records what
actually happened to the transaction. Record that output in the pull request.

The question they answer is concrete: `identity_rbac_001`,
`security_atomicity` and `invitation_origin` each contain an explicit
`BEGIN;…COMMIT;`. In `identity_rbac_001` that block is in the **middle** of the
file. If a later statement fails, anything already committed by that block
cannot be rolled back by the runner. If S8 reports that the enum swap and tables
survive a late failure, then **partial application is possible** and the
recovery step in section 4 is not optional.

### Measured results

The harness was run in CI (workflow `RBAC-001 rehearsal`, run `38995249708`).
The results are the reason section 4 exists:

- **S6 — Prisma does _not_ wrap a migration in a transaction.** A failed
  two-statement migration left its first statement's table (`probe_multi_marker`)
  behind. Prisma executes the file's statements without an enclosing transaction.
- **S7 — an explicit `BEGIN;…COMMIT;` is honoured.** A failure inside the block
  left the table it created absent: the aborted transaction rolled back cleanly.
  So the only atomicity a migration has is the atomicity it writes itself.
- **S8 — partial application is confirmed possible.** A late failure in the real
  `identity_rbac_001`, after its mid-file `COMMIT`, left `MembershipRole` already
  swapped to `OWNER,ADMIN,CAMPAIGN_MANAGER,BILLING,VIEWER` **and** the RBAC tables
  created (`3/3`). The database was genuinely half-migrated.
- **S3 — a failing `identity_rbac_001` also leaves work behind before it fails.**
  The three tables created before the mid-file `COMMIT` persisted (`3/3`), while
  the enum swap did not apply (it is inside the block, which rolled back).
- **S4/S5 — the refusals hold.** `security_atomicity` failed and did **not**
  create `memberships_single_owner` or add `invitation_acceptance_pair`. Earlier
  migrations (including `organizations.suspended_at`) legitimately persisted.

**Consequence.** A failed migration can leave the schema in a state that is not
described by any single migration file, and the migration log does not always
name the real cause: the runner often reports `current transaction is aborted`
because a later statement in the same batch is rejected after the first one
failed. The preflight in section 2 — not the migration log — is what establishes
the true state. Never re-run a failed migration blindly.

## 2. Production preflight (read-only)

Run this **before** scheduling the migration. It only reads: it opens a `READ
ONLY` transaction with a 30-second statement timeout and ends in `ROLLBACK`.

```bash
docker exec -i truevine-postgres \
  psql -v ON_ERROR_STOP=1 -U truevine -d truevine_voice -f - \
  < infrastructure/scripts/rbac-001-preflight.sql 2>&1
```

Read the tagged output:

- **Any `LEDGER` row that is not `applied`** — a previous migration failed or was
  rolled back. Stop and investigate before anything else.
- **`GATE|enum_swap_safe` must be `yes`.** It is `no` when `organizations` or
  `memberships` is non-empty. The destructive enum swap in migration 2 is only
  safe on empty tables; a populated database needs a reviewed data migration
  first.
- **`INVARIANT|organizations_exactly_one_owner` must be `ok`.** If it is not,
  migration 6 will refuse and you need an owner-fix plan first.
- **`INVARIANT|invitations_*`** — reported only if `invitations` already exists.
  Any non-`ok` value will make migration 6 refuse.
- **`OBJECT` rows** detect a partially applied RBAC-001 (some tables present
  without a corresponding ledger entry). Any unexpected `present` is a stop.
- **`INFO|current_role_superuser`** and **`OBJECT|extension:citext`** tell you
  whether the migration role can create `citext`. `citext` is a trusted
  extension, so the database owner can create it; if it is absent and the role
  is not the owner, have a DBA run `CREATE EXTENSION citext` first.

## 3. Applying to production (supervised operator action)

`prisma migrate deploy` is a controlled-environment command (AGENTS.md 12). It
is never run by CI and never on a pull request against a real database.

1. **Back up and prove the restore.** Follow
   [PostgreSQL and Redis recovery](./postgres-redis-recovery.md). The migration
   is not reversible once identity data exists; the backup is the safety net.
2. **Preflight passes** (section 2), every gate `ok`.
3. **Record the current state**: production `git` SHA from `/health`, the
   `_prisma_migrations` contents, and the `DEPLOYMENT_READY` value.
4. **Freeze writers.** Stop application processes that write identity data, or
   enter a maintenance window. Migration 6 takes a lock on `organizations`,
   `memberships` and `invitations`.
5. **Apply**, from a controlled environment with the production `DATABASE_URL`:
   ```bash
   npm run prisma:migrate:deploy
   ```
6. **Verify**: the ledger records all seven as applied; `MembershipRole` is the
   post-swap label set; the objects, functions and triggers from S1 are present.
   Re-run the preflight and confirm every `OBJECT` is `present` and no `LEDGER`
   row is failed.
7. **Unfreeze writers.**
8. Enabling deployment (`DEPLOYMENT_READY`) is a **separate, reviewed step** and
   is not part of this runbook.

## 4. If a migration fails

Do **not** simply re-run `prisma migrate deploy`. Depending on S8's finding the
database may be half-migrated, and a re-run can fail again on an object that
already exists.

1. `SELECT migration_name, finished_at, rolled_back_at FROM _prisma_migrations;`
   to see which migration failed and which applied.
2. Run the preflight and read the `OBJECT` and `LEDGER` rows to establish exactly
   what was and was not created.
3. If the failing migration left **no** partial objects, mark it rolled back and
   fix the cause:
   ```bash
   npx prisma migrate resolve --rolled-back <migration_name>
   ```
4. If it left **partial** objects, do not re-run it. Restore from the step 1
   backup, or write a reviewed forward migration that completes the half-applied
   change. `security_atomicity` and `invitation_origin` rollbacks weaken security
   and are **not** approved live rollbacks — prefer a forward fix.
5. Rehearse the fix in the harness before touching production again.

Migration-level rollback statements are recorded in each migration file's
header comment; none of them are safe once identity data exists.

## 5. Remaining blockers

- **Partial application is confirmed possible (S8).** The RBAC-001 migrations
  are not atomic as a set, and `identity_rbac_001` is not atomic as a file. The
  recovery step in section 4 is therefore mandatory if any migration fails.
- **Direct production database state is unknown from outside the VPS.** The
  preflight in section 2 must be run by an operator with `docker exec` access
  before the migration is scheduled.
- **The rehearsal's PostgreSQL role is the image's bootstrap superuser**, which
  is more privileged than the production `truevine` role. The rehearsal
  therefore tests the SQL, not the production role's privileges. The preflight
  covers the one privilege that matters (`citext`).
