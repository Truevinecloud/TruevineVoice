# W2-02 acceptance tracking

## Increment 1 — Contacts

The user reported successful manual testing in the live application using the
QA Admin account after the CI/CD phone correction release
`eb627bba33a731c0d803df67afa7790628694b88`. These are user-reported live results,
not an independently automated browser test by the coding agent.

| Check | Live acceptance status |
| --- | --- |
| Create and list contacts | Passed — user manual QA |
| View contact details | Passed — user manual QA |
| Search contacts | Passed — user manual QA |
| Edit name/email | Passed — user manual QA |
| Correct phone and save changes | Passed — user manual QA |
| Contact deletion | Pending formal live verification |
| Viewer/Billing restrictions | Pending formal live verification |
| Cross-tenant isolation | Pending formal live verification |

Passing automated RBAC/isolation/deletion tests do not close the three pending
live acceptance checks above.

## Increment 2 — Contact groups and memberships

Implementation: reuse the existing organization-scoped group/membership schema,
create/list API and group contact filter. Add detail, rename, delete, member
listing and idempotent add/remove operations, plus essential UI. No schema
migration, CSV import UI, consent/suppression UI or full redesign is included.

Production deployment and live acceptance are pending explicit authorization
after passing CI and review/merge. Use only the protected GitHub Actions workflow.

Prepared live journey in the existing `truevoice-testing` organization:

1. Confirm exact release SHA, REVISION, READY and healthy PostgreSQL/Redis.
2. Use the existing authorized QA session and confirm the selected organization.
3. Create a uniquely labelled synthetic group; view and rename it.
4. Use a newly created disposable synthetic contact. Add it to the group, reload
   and confirm membership/count. Add it to a second synthetic group if testing
   multiple membership. Do not use existing production contacts.
5. Remove the membership; reload and confirm the contact still exists. Do not
   change consent, suppression or campaign references.
6. Delete only the task-created synthetic group after action-time confirmation;
   confirm contacts are retained. Keep immutable audit evidence.
7. Use existing authorized Viewer/Billing and other-tenant sessions for formal
   live boundary checks when available. Record unavailable sessions as pending.

Never mark Increment 2 live checks passed from CI alone or bypass session/terms/
permissions to obtain evidence.
