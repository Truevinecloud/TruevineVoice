# RC1 migration plan (preparation only)

**No migration has been executed against a production or shared target.** This plan
prepares an owner-approved, supervised release. Isolated disposable validation was
executed on a private loopback PostgreSQL stack; owner approval gates remain `PENDING`.

## 1. Inventory: 33 reviewed migrations

Source: `infrastructure/migrations-reviewed.json:19-52`.

### Baseline on deployed main `8fcb552...` — 22 entries

Confirmed with `git show 8fcb552...:infrastructure/migrations-reviewed.json`.

| # | Migration |
| --- | --- |
| 1 | `20261014042915_tenancy_core` |
| 2 | `20261016130500_identity_rbac_001` |
| 3 | `20261016141500_identity_audit_events` |
| 4 | `20261016142500_identity_audit_fk_restrict` |
| 5 | `20261016153000_organization_suspension` |
| 6 | `20261016170000_security_atomicity` |
| 7 | `20261016171000_invitation_origin` |
| 8 | `20261019120000_campaigns_rbac_003` |
| 9 | `20261019160000_customer_billing_rbac_004` |
| 10 | `20261020110000_rbac_007_emergency_stop` |
| 11 | `20261020180000_platform_owner_bootstrap` |
| 12 | `20261020181000_platform_owner_bootstrap_no_truncate` |
| 13 | `20261020182000_platform_owner_bootstrap_search_path` |
| 14 | `20261021120000_call_persistence` |
| 15 | `20261021150000_sensitive_audit_integrity` |
| 16 | `20261022110000_rbac_014_support_access_sessions` |
| 17 | `20261022120000_contacts_groups_import_w2_02` |
| 18 | `20261024180000_audio_assets_w3_02` |
| 19 | `20261025100000_audio_usage_trigger_error_mapping` |
| 20 | `20261025110000_campaign_builder_w3_03` |
| 21 | `20261030120000_payment_provider_configuration` |
| 22 | `20261107120000_payment_intent_foundation` |

### New in this RC branch — 11 entries

Confirmed added by
`git diff --name-status 8fcb552...HEAD -- infrastructure/migrations-reviewed.json packages/database/prisma/migrations`.

| # | Migration | Manifest line |
| --- | --- | --- |
| 1 | `20261119134000_rbac_015_custom_roles` | 42 |
| 2 | `20261120120000_audio_storage_bytea_w3_04` | 43 |
| 3 | `20261120130000_voice_provider_configuration` | 44 |
| 4 | `20261122120000_voice_callback_receipts` | 45 |
| 5 | `20261122121200_campaign_call_initiation_operation` | 46 |
| 6 | `20261122150000_durable_call_initiation_reconciliation` | 47 |
| 7 | `20261123110000_audio_usage_campaign_set_null` | 48 |
| 8 | `20261123120000_usage_settlement_w5_01` | 49 |
| 9 | `20261124130000_w601_campaign_reliability` | 50 |
| 10 | `20261125120000_w504_sms_fallback_operations` | 51 |
| 11 | `20261126000000_w504_sms_fallback_entitlement` | 52 |

PR #129 commit `6de23cd2` (re-listing `20261107120000_payment_intent_foundation`) was
intentionally skipped: deployed main already has that PR #130 entry.

## 2. Authority boundary

| Statement | Evidence |
| --- | --- |
| The manifest permits code to deploy; it is not permission to execute migrations. | `infrastructure/migrations-reviewed.json:3-17`, especially lines 14-17. |
| CI applies migrations only to a runner-local disposable database, never production. | `.github/workflows/ci.yml:204-215`. |
| The deployment activation path applies reviewed SQL before PM2 activation. | `infrastructure/scripts/deploy.mjs:248-286` calls `npm run prisma:migrate:deploy`; README lines 548-556 and `docs/runbooks/production-deployment.md:416-427`. |
| Activation requires explicit reconciliation/approval first. | `docs/runbooks/production-deployment.md:393-404`, 424-427; `docs/adr/0011-reviewed-deployment-migrations.md`. |
| This plan does not authorize or execute activation. | No owner approval is recorded here; all evidence fields remain PENDING. |

## 3. Known schema/SQL reconciliation items

| Item | Status | Evidence |
| --- | --- | --- |
| Audio enum identifier | Resolved in code, not by hand-editing an applied migration. Reviewed SQL creates lowercase `audio_storage_backend` (`20261120120000_audio_storage_bytea_w3_04/migration.sql:5`). RC schema maps the Prisma enum to that identifier. | `git show b343dd1 -- packages/database/prisma/schema.prisma`; no migration file was edited. |
| Audio-usage FK action | **Resolved in the RC schema.** Reviewed SQL uses `ON DELETE SET NULL ("campaign_id")` (`20261123110000_audio_usage_campaign_set_null/migration.sql:10-18`); `AudioAssetUsage.campaign` now declares `onDelete: SetNull` instead of `Restrict`. No migration was hand-edited. | Fresh and upgrade `prisma migrate diff --from-config-datasource --to-schema ... --exit-code` both exit `0` with an empty migration (`artifacts/schema-drift-fresh.txt`, `artifacts/schema-drift-upgrade.txt`). |
| Other schema/DB drift | Resolved by aligning relation names, referential actions and index names in `schema.prisma` with the reviewed SQL. | Same two drift files; no generated SQL differences remain. |
| Manifest/SQL directory check | 33 manifest entries and 33 migration directories match exactly; no unlisted or missing migration. | Re-checked at final validation: `manifest=33 directories=33 no differences`. `infrastructure/scripts/deploy.mjs:250` calls `assertReviewedMigrations` at activation. |

### Disposable E2E evidence

| Check | Outcome | Evidence |
| --- | --- | --- |
| Full API E2E against a freshly migrated disposable database | exit `0`, 25 files / 314 tests | `artifacts/e2e-api-serial.log`, `artifacts/e2e-api-serial.exit`. Includes `tenant-isolation.e2e-spec.ts`, `billing.e2e-spec.ts`, `payment-intents.e2e-spec.ts`, `security-remediation.e2e-spec.ts` and `production-test-rollout.e2e-spec.ts`. |
| Worker E2E against the disposable Redis container | exit `0`, 1 file / 5 tests | `artifacts/e2e-worker.log`. |
| Security harness migration rehearsals | 5/5 gates passed | `artifacts/test-security.log`: empty DB, representative-row preservation, and three inconsistent-data rejections without partial changes. |
| Schema drift after final reconciliation | exit `0`, empty migration on both disposable databases | `artifacts/schema-drift-fresh.txt`, `artifacts/schema-drift-upgrade.txt`; Prisma advisory `SetNull` warning remains documented below. |

## 4. Controlled execution plan

Ordered checklist. Disposable iterations 4–7 were executed against isolated databases
created for this rehearsal. Controlled-environment and approval iterations remain PENDING.

| Step | Action / command by reference | Evidence field |
| --- | --- | --- |
| 1 | Record exact release identity: branch `integration/production-release-rc1`, validated RC commit `41dc083...`, target main SHA to be determined at merge. Confirm `origin/main` is `8fcb552...` before merge. | DONE for the validated RC commit; merge SHA remains PENDING |
| 2 | Preflight backup using the reviewed backup/restore procedure at `docs/runbooks/postgres-redis-recovery.md`; verify a non-zero, restorable archive before any migration discussion. Do not restore over production. | PENDING — run in disposable environment |
| 3 | Baseline status: `npm run prisma:migrate:status` against the intended controlled target; record the 22 baseline migrations as applied and confirm no unexpected pending or failed rows. Never print connection strings. | PENDING — run in disposable environment |
| 4 | Fresh isolated DB apply: apply all 33 migrations to a new disposable database via `npm run prisma:migrate:deploy` with a privately supplied disposable `DATABASE_URL`; confirm zero pending migrations. | DONE in disposable DB `truevine_rc1_fresh` — exit `0`, all 33 applied (`artifacts/migrate-fresh.log`). |
| 5 | Baseline-upgrade isolated DB apply: reproduce the deployed baseline, then apply only the 11 new migrations; verify no P2003/unique/index failures and no implicit data rewrite. | DONE in disposable DB `truevine_rc1_upgrade` — 22 baseline then 11 release migrations, both exit `0` (`artifacts/migrate-baseline.log`, `artifacts/migrate-upgrade.log`). |
| 6 | Generate and review SQL with `prisma migrate diff --from-config-datasource --to-schema ./packages/database/prisma/schema.prisma --script --exit-code` against both disposable databases. | DONE — both exit `0` with an empty migration. A first attempt on the fresh DB hit a transient `P1001`; an immediate retry succeeded with no schema change. |
| 7 | Synthetic tenant data checks (next table). | DONE for row-preservation checks in the disposable baseline/upgrade pair; persistent constraints and live cross-tenant checks remain PENDING. |
| 8 | Owner reconciliation/approval: confirm backward compatibility with deployed `8fcb552...`, record the approved exact SHA and backup evidence. | PENDING — owner decision required. The schema/SQL reconciliation is complete and documented above. |
| 9 | Supervised activation only via the protected workflow: `workflow_dispatch` with exact main SHA and `authorize_production=true`; `deploy.mjs` injects `-c lock_timeout=5s` (`infrastructure/scripts/deploy.mjs:262-268`) before `prisma:migrate:deploy`, and fails without activating if migration fails. | PENDING — owner approval required |
| 10 | Post-deploy status: `npm run prisma:migrate:status`; confirm no pending or failed migrations and no hand-edited history. | PENDING — controlled environment only |
| 11 | Health/route verification: `npm run deploy:verify -- <config-path> <SHA>` plus `/health` and `/` checks from another machine per `docs/runbooks/production-deployment.md:446-449`. | PENDING — controlled environment only |
| 12 | Monitor PM2, `/health`, public routes, migration ledger and error rates; keep the prior compatible READY release available for code rollback. | PENDING — controlled environment only |

### Synthetic tenant data checks

| Check | Expected contract | Evidence field |
| --- | --- | --- |
| Two-tenant synthetic dataset | Eleven representative tables each hold two organization-scoped rows before and after the release migrations. | DONE — `artifacts/baseline-synthetic-data.sql`, `artifacts/baseline-counts.txt`, `artifacts/upgrade-counts.txt`; 2 rows per table before and after. |
| Tenant scoping | Every tenant-owned row carries `organization_id`; composite keys/FKs lead with it; no foreign-tenant read succeeds. | DONE in disposable E2E — `tenant-isolation.e2e-spec.ts` passed in the 314-test serial run; live production cross-tenant check remains PENDING. |
| Constraints/indexes | Unique composite keys, append-only triggers and new indexes behave as reviewed under concurrent writes. | PENDING — static schema/drift validation only. |
| Idempotency keys | Durable keys are unique in PostgreSQL; retry reuses the original key; concurrent same-key work cannot duplicate the side effect. | PENDING — no side effect was activated. |
| Ledger append-only | Wallet entries are append-only; corrections are compensating entries; balance recomputes from entries. | PENDING — synthetic rows preserved; no charge/credit/refund executed. |
| No cross-tenant reads | Two synthetic organizations cannot read or mutate each other's audio, campaign, callback or billing rows. | PENDING — requires application-level verification. |
| Audio FK drift | Deleting a campaign with `CAMPAIGN_SELECTED` usage clears only `campaign_id`; all other usage columns remain unchanged; direct rewrites/deletes still fail. | Schema now matches reviewed SQL and drift checks are empty; behavioural delete/restrict assertion remains PENDING. |

## 5. Rollback policy

| Rule | Detail |
| --- | --- |
| Additive forward migrations | Prefer forward-compatible fixes. No destructive down migration without explicit owner approval. |
| App rollback first | On application failure, roll back to the previous compatible READY SHA using `npm run deploy:rollback -- <previous-verified-40-character-SHA>` (`docs/runbooks/production-deployment.md:431-444`). Code rollback does not reverse SQL. |
| Database restore | Restore from a vetted backup only with owner approval and a controlled cutover (`docs/runbooks/postgres-redis-recovery.md:338-355`). Never restore directly over production without that approval. |
| Expand/contract | Keep schema changes compatible with deployed `8fcb552...` so code and schema deploys can be sequenced independently (AGENTS.md 12). |
| No direct data edits | No `psql` updates, manual row edits or ad-hoc SQL against a non-disposable database (AGENTS.md 15). |

## 6. Approval gate

Migration execution is **not approved** by this document. The owner must explicitly approve
the exact SHA, the 11 new SQL files, the FK drift resolution, backup/restore evidence and the
supervised activation window before `workflow_dispatch` is used.
