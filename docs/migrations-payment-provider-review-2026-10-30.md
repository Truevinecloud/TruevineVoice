# Payment-provider configuration migration review

**Migration:** `20261030120000_payment_provider_configuration`
**Files:** `packages/database/prisma/migrations/20261030120000_payment_provider_configuration/migration.sql`
**Reviewed:** 2026-10-30
**Outcome:** Review materials prepared. **Not approved for production.** The
approval manifest (`infrastructure/migrations-reviewed.json`) is deliberately
unchanged, so `deploy:release` refuses this tree.

This review was performed statically and against Prisma's own DDL generator.
No disposable PostgreSQL instance was available in the review environment
(Docker and `psql` are absent), so the migration has **not** been applied here.
It is applied by the `e2e-tests` CI job to a throwaway Compose database, and by
`rbac-database-e2e.yml` to service containers, on every pull request. That CI
result is the execution evidence, not this document.

---

## 1. Scope and additive-only check

The migration contains only `CREATE TYPE` (×2), `CREATE TABLE` (×1), `CREATE
INDEX` (×2), one `ALTER TABLE ... ADD CONSTRAINT ... FOREIGN KEY`, and four
`ADD CONSTRAINT ... CHECK` statements on the new table. It does not alter, drop,
rename or rewrite any existing table, column, index, enum or row, and it takes
no lock that outlives its own transaction beyond the brief catalog locks needed
to add the foreign key to the new (empty) table.

| Statement                                        | Existing object touched | Effect                                                        |
| ------------------------------------------------ | ----------------------- | ------------------------------------------------------------- |
| `CREATE TYPE "PaymentProvider"`                  | —                       | new enum                                                      |
| `CREATE TYPE "PaymentProviderEnvironment"`       | —                       | new enum                                                      |
| `CREATE TABLE "payment_provider_configurations"` | —                       | new table, empty                                              |
| two indexes + PK                                 | —                       | on the new table                                              |
| FK → `users(id)`                                 | `users`                 | catalog-level FK; validation scans zero rows in the new table |
| four CHECKs                                      | —                       | on the new table                                              |

`ON DELETE RESTRICT` on `updated_by_user_id` matches the model: a user with
configuration history cannot be deleted, which is consistent with the existing
audit-retention decision (ADR 0009). `ON UPDATE CASCADE` is Prisma's default and
harmless because `users.id` is never updated.

## 2. Schema parity

`prisma migrate diff --from-empty --to-schema prisma/schema.prisma --script`
(Prisma 7.10.1) was used to compare the migration against the datamodel. It
produces the same table name, columns, PostgreSQL types, defaults, primary key,
`(provider, environment)` unique index, `(provider, active)` index and the
`users` foreign key. The two enum types match.

One parity defect was found and corrected **in the unreviewed migration** before
this review was written:

- Prisma's generated DDL for `String[] @default([])` is `TEXT[] DEFAULT
ARRAY[]::TEXT[]` (nullable array). The migration had added `NOT NULL`, which
  `prisma migrate dev` would have proposed dropping, creating permanent schema
  drift. The column now matches Prisma, and the presence CHECK uses
  `coalesce(cardinality(credential_fields), 0)` so a NULL array is still treated
  as "no fields" rather than silently passing the CHECK.

The migration has never been applied anywhere, so editing it is safe; no applied
migration was modified.

## 3. Constraints and indexes

| Object                                   | Purpose                                                | Failure it prevents                                                          |
| ---------------------------------------- | ------------------------------------------------------ | ---------------------------------------------------------------------------- |
| unique `(provider, environment)`         | one row per provider/environment                       | duplicate credential sets                                                    |
| unique partial `(provider) WHERE active` | one active environment per provider                    | sandbox and production taking traffic at once                                |
| index `(provider, active)`               | lookup of the active row                               | sequential scans (small table)                                               |
| CHECK credentials presence               | configured ⇔ ciphertext + ≥1 field name                | a "configured" row with no usable secret, or a secret with no field metadata |
| CHECK active requires credentials        | active ⇒ ciphertext ∧ callback URL                     | activating an unusable configuration                                         |
| CHECK activation timestamps              | `active` agrees with `activated_at` / `deactivated_at` | contradictory timestamps                                                     |
| CHECK callback URL                       | `^https://[^\s#?]+$`                                   | plaintext HTTP, query strings, fragments (a routing token hidden in the URL) |
| CHECK `version > 0`                      | optimistic concurrency                                 | zero/negative version                                                        |

The application mirrors these rules (service validation plus the partial index
error mapping in `PrismaPaymentProviderStore`), but the database is the final
authority. A concurrent activation that loses the unique-index race is mapped to
`other_environment_active`, not a 500.

`callback_url` is configuration, not a credential, but it is still excluded from
audit metadata because a URL can contain a routing token.

## 4. Rollback

Documented in the migration header:

```sql
DROP TABLE payment_provider_configurations;
DROP TYPE "PaymentProviderEnvironment";
DROP TYPE "PaymentProvider";
```

Safe only while the table is empty. Once credentials exist this is
**forward-only**: the encrypted values cannot be reconstructed from the audit
trail, and code rollback does not undo SQL (ADR 0011). No automatic rollback or
reset exists. A failed `prisma migrate deploy` must be inspected securely before
retrying.

## 5. Ordering and ledger compatibility

- The directory timestamp `20261030120000` sorts after the current head
  `20261025110000_campaign_builder_w3_03`, so it is the last migration in the
  release.
- It is absent from `infrastructure/migrations-reviewed.json`, whose last entry
  is `20261025110000_campaign_builder_w3_03`. `assertReviewedMigrations` checks
  both directions, so the current tree is refused by `deploy.mjs` until a human
  adds this entry.
- Adding the entry is the approval action required by ADR 0011. Deployment then
  runs `prisma migrate deploy` before PM2 activation; the deployed code and the
  migration therefore land in the intended order.
- Because the change is additive, the currently deployed application is
  compatible with the migrated schema, and the new application is compatible
  with the new schema. Code rollback leaves the empty table in place; the old
  application ignores it.

## 6. Residual risks and prerequisites for approval

1. **Execution evidence on real PostgreSQL is required.** Run the migration and
   the payment persistence E2E suite
   (`apps/api/test/payment-providers.e2e-spec.ts`) against a disposable
   database before approving. Locally this requires Docker; the PR's CI
   `e2e-tests` job provides it.
2. **Backup and recovery.** Confirm the current production backup/restore
   procedure and a recovery plan before applying; see the production runbook.
3. **Secret provisioning.** `PAYMENT_CREDENTIAL_ENCRYPTION_KEY` must be in the
   production `.env` before this release's API starts, or the API refuses to
   boot. See ADR 0024 and the runbook.
4. **No real provider credentials or activation** are part of this migration.
   The table can ship empty and inert.
5. **Key loss makes ciphertext unreadable.** No rotation or re-encryption
   procedure exists; that is a separate reviewed change.

## 7. Reviewer checklist

- [ ] SQL reviewed line by line against this document.
- [ ] Migration applied to a disposable PostgreSQL instance via
      `prisma migrate deploy`; `_prisma_migrations` records it as applied.
- [ ] Payment persistence E2E suite passed against that instance.
- [ ] Backup and restore rehearsed for the target environment.
- [ ] Deployment order (migration before PM2 activation) confirmed.
- [ ] `PAYMENT_CREDENTIAL_ENCRYPTION_KEY` provisioning confirmed by the release
      operator (no value recorded in this repository).
- [ ] Entry added to `infrastructure/migrations-reviewed.json` in a separate,
      reviewed change.

Until every box is ticked, this migration must not be added to the manifest and
the release must not be deployed.
