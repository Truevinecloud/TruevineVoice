# RC1 W5-01 migration review and approval record

Status: **review evidence only — production execution not approved**.

This record documents the SQL review of one migration:
`20261123120000_usage_settlement_w5_01`. It does not approve a merge, a
deployment, a `workflow_dispatch`, a manual migration, a charging action, or any
production database change.

`infrastructure/migrations-reviewed.json` is a review allow-list. A manifest
entry permits the migration directory to exist in a deployable tree; it does not
apply the SQL or authorize production execution. In RC1, production migrations
run only inside the protected deployment workflow after all release gates pass,
including verified backup/recovery evidence and this explicit owner approval.

## Reviewed artifact

| Field | Value |
| --- | --- |
| Migration | `20261123120000_usage_settlement_w5_01` |
| File | `packages/database/prisma/migrations/20261123120000_usage_settlement_w5_01/migration.sql` |
| Git blob | `18427d685da0f7a37aef857806fd8095a5768168` |
| SHA-256 | `00f9e4bae3b8fc7b4ff17d0e9b10bb06f320283fab9f2121636b7fcf158b50a0` |
| Manifest entry | `infrastructure/migrations-reviewed.json` migration array |
| Production SQL applied | No |
| Production host or data accessed | No |
| Secrets printed or recorded | No |

## Exact SQL findings

### Structure and transaction

1. The file is wrapped in one `BEGIN; ... COMMIT;` block. All DDL in the file is
   transactional: a statement error before `COMMIT` rolls the migration's DDL
   back. Prisma records success separately in `_prisma_migrations`.
2. The migration is not idempotent when replayed as raw SQL. Re-running it after
   successful application will fail on already-existing object names. Retry
   behaviour must come from Prisma's ledger and the protected workflow, not from
   manual re-execution.
3. There is no explicit `LOCK` statement and no `IF NOT EXISTS`. The
   `ALTER TABLE` and index creation still take PostgreSQL DDL locks; the
   deployment path injects `-c lock_timeout=5s` before `prisma migrate deploy`,
   so lock contention should fail the migration rather than block activation
   indefinitely.
4. `ALTER TABLE "voice_callback_bindings" ADD CONSTRAINT
   "voice_callback_bindings_full_key" UNIQUE ("source", "session_id",
   "organization_id", "attempt_id")` changes an existing table. It depends on the
   reviewed prior migration `20261122120000_voice_callback_receipts`, which owns
   that table and its `(source, session_id)` primary key. The constraint can fail
   if the deployed schema or existing rows differ from that reviewed lineage;
   it must not be removed, renamed, or bypassed to make a deployment pass.
   Existing deployed code must not create duplicate full keys after the schema
   change.

### Tenant scope and referential integrity

5. `voice_usage_quotes`, `voice_usage_events` and `voice_usage_reversals` use
   organization-leading composite primary keys: `("organization_id", "id")`.
6. Every new table has a foreign key to `organizations` directly or through a
   tenant-leading parent. Quotes and events reference
   `voice_callback_bindings` on `(source, session_id, organization_id,
   attempt_id)`; events reference quotes on `(organization_id, quote_id)`, the
   wallet debit on `(organization_id, debit_entry_id)`, and the callback binding
   on the full composite key; reversals reference the usage event on
   `(organization_id, usage_event_id)` and the wallet credit on
   `(organization_id, credit_entry_id)`. All use `ON DELETE RESTRICT ON UPDATE
   CASCADE`.
7. `voice_usage_quotes_attempt_key` is unique on `(organization_id,
   attempt_id)`, and `voice_usage_events_event_key_key` is unique on
   `(organization_id, receipt_event_key)`. The event quote key is unique on
   `(organization_id, quote_id)`, so one trusted quote funds at most one charge.
8. `voice_usage_quotes_session_key` is globally unique on `(source,
   session_id)`, not organization-scoped. This mirrors the existing
   `(source, session_id)` primary key on `voice_callback_bindings`. It is an
   availability/cross-tenant collision constraint, not tenant authorization.
   The application must still enforce tenant scope; this SQL does not prove it.
9. The migration adds no row-level security policy. Tenant isolation remains a
   composite-key/first-line application control plus the rest of the reviewed
   schema, not a claim that direct SQL access is tenant-safe.

### Money and ledger

10. All amounts are `BIGINT` integer minor units: `billed_seconds` is a positive
    `INTEGER`; `rate_per_second_minor`, `customer_charge_minor` and
    `provider_cost_minor` are integer minor units. No floating-point money value
    appears in the SQL.
11. `currency` is fixed to `'UGX'` on quotes and events. Provider cost is a
    nullable amount with a paired `provider_cost_currency`; the pair check
    requires both or neither, and the provider currency check allows only `UGX`
    when present. Provider cost is evidence only, not the customer charge.
12. Quotes and events each enforce
    `customer_charge_minor = rate_per_second_minor * billed_seconds` in a
    database `CHECK`. There is no cross-table database constraint proving that
    an event's amount, rate, seconds or pricing version equals the referenced
    quote's values.
13. Events reference an existing append-only `wallet_entries` debit. Reversals
    reference an existing append-only `wallet_entries` credit. No balance column
    is created or updated; balance remains the sum of ledger entries.
14. There is no database check that the referenced wallet debit is negative or
    that its direction/type is correct. `wallet_entries` has no direction column,
    so sign cannot be constrained by this migration.
15. There is no database check that a reversal credit amount equals or reverses
    the original event charge. `voice_usage_reversals_usage_key` prevents more
    than one reversal per event, but the amount relationship is an application
    responsibility and is recorded here as an accepted residual risk only if
    the owner explicitly approves it.
16. `voice_usage_quotes`, `voice_usage_events` and `voice_usage_reversals` each
    have two triggers using `reject_w5_usage_history_mutation()`: `BEFORE UPDATE
    OR DELETE` and `BEFORE TRUNCATE`. The history is append-only at the database
    level. Corrections must be new rows, never edits to these rows.

### Compatibility, failure and rollback

17. The migration is additive except for the new unique constraint on
    `voice_callback_bindings`. It creates no destructive down migration. The
    active release's code does not depend on the new tables, but the new
    constraint affects writes to an existing table and must be covered by the
    backward-compatibility review.
18. The migration introduces no provider SDK import and no provider network
    call. It is schema only.
19. A migration failure prevents activation and leaves the active release
    untouched. It may leave a Prisma migration ledger row that requires secure
    inspection; do not hand-edit SQL, `_prisma_migrations`, or live data to get
    past it.
20. Code rollback to a prior READY SHA does not reverse this SQL. Restoring the
    database from backup returns the ledger to its pre-migration state but is a
    separate destructive operation requiring its own explicit approval. It is
    never performed over live production by preflight or by this approval
    record.

## Required owner approval fields

Every field below is `PENDING`. This record becomes migration execution approval
only when the owner replaces each `PENDING` value with an explicit decision and
identifies the exact approved release SHA.

| Field | Required decision/evidence | Status |
| --- | --- | --- |
| Owner identity | Named repository owner/approver | PENDING |
| Approved exact release SHA | Full 40-character main SHA, with CI evidence | PENDING |
| Approval timestamp and expiry | Date/time and explicit validity window | PENDING |
| SQL artifact approval | Git blob `18427d685da0f7a37aef857806fd8095a5768168` and SHA-256 above | PENDING |
| Findings 1–20 accepted | Explicit acceptance, including residual findings 8, 9, 12, 14 and 15 | PENDING |
| Backward-compatibility decision | Explicit finding for the new unique constraint on `voice_callback_bindings` | PENDING |
| Lock/failure decision | Acceptance of `lock_timeout=5s`, transactional failure and ledger inspection | PENDING |
| Backup evidence | RC1 preflight backup, checksum and archive readability evidence | PENDING |
| Recovery evidence | Isolated restore and restore-forward rehearsal evidence | PENDING |
| Exact pending migrations | Confirmation that `20261123120000_usage_settlement_w5_01` is in the derived pending set | PENDING |
| Activation window | Approved protected-workflow dispatch window, not a manual migration | PENDING |
| Rollback/restoration acknowledgement | Code rollback does not reverse SQL; any database restoration is separately approved | PENDING |
| Owner signature | Owner-specific recorded signature/reference | PENDING |

## Prohibitions

- No manual `prisma migrate deploy` against production.
- No `migrate resolve`, `db push`, reset, direct SQL update, or hand-edit of an
  applied migration or `_prisma_migrations`.
- No production restore or production data edit under this approval record.
- No live charge, credit, refund, provider callback, Voice call or SMS action.
- No treating this document, the manifest entry, a disposable rehearsal, or a
  successful code deployment as owner approval.
