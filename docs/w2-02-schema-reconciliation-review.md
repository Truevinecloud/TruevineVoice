# W2-02 schema reconciliation review

Status: **schema and database acceptance verified; migration listed in the release-candidate manifest; production rollout remains blocked on backup and isolated-restore evidence**.

Candidate base: `ac16a99cbca8b18367266a9d2432d57a80736b1e`.

Verified implementation commit: `d91e6c879fc3eced24ce6a45a5fd421bacaedca9`.

## Authoritative schema preserved

`20261021120000_call_persistence` already creates `contacts` with the tenant-scoped `(organization_id, id)` primary key, canonical E.164 `destination`, `label`, and the `campaign_recipients` foreign key. W2-02 keeps those columns and the existing `Contact` Prisma model. The new migration uses `ALTER TABLE contacts ADD COLUMN`; it does not recreate the table, rewrite IDs, change recipient snapshots, backfill existing data, or edit any earlier migration.

New contact-management values (`phone_e164`, email, consent evidence, suppression and creator) are nullable on legacy contact rows. W2-02-created/imported records set both `destination` and `phone_e164`, and map display name to the existing `label`. `phone_e164` uniqueness is tenant-scoped; PostgreSQL permits multiple nulls so legacy rows remain untouched. The creator and consent-verifier foreign keys include `(organization_id, user_id)` into `memberships`, enforcing the tenant boundary in the database. Group and import tables also carry organization-scoped keys.

When an import encounters a legacy row whose canonical `destination` matches, it adopts that row's existing ID and adds the normalized phone field. If multiple legacy rows match, the import reports `ambiguous_existing_duplicate` and leaves every row unchanged. Existing campaign recipient snapshots retain their copied destination even if the contact's destination later changes.

## Migration and rollback review

The new migration is one PostgreSQL transaction. A forced error before commit leaves no W2-02 columns, types or tables behind. After successful application, code rollback is safe because all DDL is additive; the schema is intentionally retained. No down migration or destructive cleanup is proposed. The W2-02 migration is listed in `infrastructure/migrations-reviewed.json` after the full-history disposable migration rehearsal and database-backed acceptance suite passed. This candidate manifest entry permits the migration in a reviewed release tree; it does not itself authorize a production migration.

## Verification still required

- **Passed, GitHub Actions, tested implementation commit `d91e6c879fc3eced24ce6a45a5fd421bacaedca9`:** full-history disposable migration rehearsal, including late-failure rollback, legacy contact and recipient preservation, tenant-scoped creator FKs, cross-tenant group rejection and duplicate-phone isolation ([run](https://github.com/Truevinecloud/TruevineVoice/actions/runs/39823193446)).
- **Passed, same tested commit:** PostgreSQL contact acceptance suite, 5/5 tests, within the end-to-end job; the full e2e job passed ([run](https://github.com/Truevinecloud/TruevineVoice/actions/runs/39823193477)). It covers tenant isolation, imports and retry behavior, duplicate handling, consent, suppression, and legacy contact adoption.
- **Passed, same tested commit:** required CI quality, unit, build, e2e, billing/campaign database, and migration checks ([PR checks](https://github.com/Truevinecloud/TruevineVoice/pull/51)).
- **Still required before production migration:** obtain a current production backup and pass isolated restore verification through the approved runbook. Workspace SSH authentication was denied, so the operator must run the documented commands and provide the result.

No production database was queried or changed during preparation. Campaign dispatch-time consent/suppression enforcement remains a separate unfinished integration dependency.
