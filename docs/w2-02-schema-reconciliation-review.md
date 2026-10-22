# W2-02 schema reconciliation review

Status: **prepared for disposable verification; migration approval remains pending**.

Candidate base: `ac16a99cbca8b18367266a9d2432d57a80736b1e`.

## Authoritative schema preserved

`20261021120000_call_persistence` already creates `contacts` with the tenant-scoped `(organization_id, id)` primary key, canonical E.164 `destination`, `label`, and the `campaign_recipients` foreign key. W2-02 keeps those columns and the existing `Contact` Prisma model. The new migration uses `ALTER TABLE contacts ADD COLUMN`; it does not recreate the table, rewrite IDs, change recipient snapshots, backfill existing data, or edit any earlier migration.

New contact-management values (`phone_e164`, email, consent evidence, suppression and creator) are nullable on legacy contact rows. W2-02-created/imported records set both `destination` and `phone_e164`, and map display name to the existing `label`. `phone_e164` uniqueness is tenant-scoped; PostgreSQL permits multiple nulls so legacy rows remain untouched. The creator and consent-verifier foreign keys include `(organization_id, user_id)` into `memberships`, enforcing the tenant boundary in the database. Group and import tables also carry organization-scoped keys.

When an import encounters a legacy row whose canonical `destination` matches, it adopts that row's existing ID and adds the normalized phone field. If multiple legacy rows match, the import reports `ambiguous_existing_duplicate` and leaves every row unchanged. Existing campaign recipient snapshots retain their copied destination even if the contact's destination later changes.

## Migration and rollback review

The new migration is one PostgreSQL transaction. A forced error before commit must leave no W2-02 columns, types or tables behind. After successful application, code rollback is safe because all DDL is additive; the schema is intentionally retained. No down migration or destructive cleanup is proposed. The W2-02 directory remains absent from `infrastructure/migrations-reviewed.json` until the full-history disposable migration rehearsal and database-backed acceptance suite pass.

## Verification still required

- Replay the existing migration history in a disposable database, seed a contact and campaign recipient, apply W2-02, and verify IDs, tenant keys, destination, label and recipient FK are unchanged.
- Verify late-failure transaction rollback, membership-scoped creator/verifier FKs, cross-tenant group-member rejection and organization-scoped normalized-phone uniqueness.
- Run the database-backed import/consent/suppression acceptance tests and the required candidate CI.
- Obtain a current production backup and isolated-restore evidence through the approved runbook before any production migration.

No production database was queried or changed during preparation. Campaign dispatch-time consent/suppression enforcement remains a separate unfinished integration dependency.