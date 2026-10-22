# Database migrations

Prisma stores one folder per migration in this directory.

| Migration                     | Introduces                                                 |
| ----------------------------- | ---------------------------------------------------------- |
| `20261014042915_tenancy_core` | `organizations`, `memberships`, `MembershipRole` (tenancy) |
| `20261021120000_call_persistence` | Existing `contacts`, campaign recipients and call history |
| `20261022120000_contacts_groups_import_w2_02` | Additive contact management fields, groups and resumable imports |

W2-02 extends the existing `contacts` table; it does not recreate or replace the
campaign contact model. Its migration must remain unlisted in the reviewed
migration manifest until the disposable migration rehearsal and database-backed
acceptance tests pass. Money rules (AGENTS.md 6-7) and idempotency (AGENTS.md 9)
remain separate from this task.

```
npm run prisma:migrate:dev -- --name <descriptive_name>
```

Rules that apply to every migration in this repository:

- Never hand-edit an already-applied migration. Add a new one instead.
- Never reset or drop a database that holds data you did not create.
- Review the generated SQL before applying it anywhere that is not disposable.
- Schema changes must remain backward compatible with the currently deployed
  application version (expand/contract), so that deploys and migrations can
  happen independently.

## Production

**Adding a migration blocks production deployment.** `assertNoMigrations` in
`infrastructure/scripts/deploy.mjs` refuses to deploy a tree whose migrations
directory contains anything but this file. The check is intentional.

The reviewed SQL, backward-compatibility argument, rollback and supervised
execution plan for `20261014042915_tenancy_core` are in
[ADR 0006](../../../../docs/adr/0006-tenancy-core-schema.md). Read it before
changing the interlock. Applying a migration is a supervised operator action
performed from a controlled environment with a rehearsed backup, never a CI side
effect and never against a database you did not create.
