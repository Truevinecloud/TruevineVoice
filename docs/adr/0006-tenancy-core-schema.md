# ADR 0006: Tenancy is enforced by the schema, not by query discipline

- **Status:** Accepted
- **Date:** 2026-10-14

## Context

The Prisma schema was deliberately empty. It now carries the tenancy core:
`Organization`, `Membership` and `MembershipRole`.

The question this ADR answers is not "which tables exist" but **where tenant
isolation is enforced**. AGENTS.md 5 requires organization scoping in the
database, and calls an application check "the first line of defence, not the
only one". The practical question is what shape the schema takes so that a
missing `where` clause is a bug rather than a data breach.

`Membership` is the first tenant-owned table, so whatever pattern it establishes
is the pattern every later table copies. Getting it wrong here means every
future table inherits the mistake.

## Decision

**Tenant scope is part of row identity, expressed as composite keys and foreign
keys. No `tenantId`-only columns, no unscoped surrogate primary keys.**

`memberships` has no `id`. Its primary key is `(organization_id, user_id)`.

Three consequences follow, and all three are deliberate:

1. **A membership cannot exist without an organization.** The tenant scope is
   part of the primary key, so it cannot be `NULL` and cannot be forgotten in a
   later migration.
2. **A user holds at most one role per organization.** Two rows would need a
   duplicate `(organization_id, user_id)`, which the primary key rejects. This
   removes an entire class of "which role applies" ambiguity.
3. **Authorization is a per-tenant decision.** The same person in two
   organizations is two memberships with independent roles. A user cannot
   inherit access to an organization they were not granted.

`@@unique([userId, organizationId])` exists alongside the primary key for a
different reason: resolving "which organizations can this user act in?" leads
with `user_id`, and that lookup must be served by an index rather than a scan.
It is not a second source of uniqueness truth.

The foreign key is `(organization_id) -> organizations(id)` with `ON DELETE
CASCADE`. Deleting an organization removes its memberships rather than leaving
authorization rows pointing at something that no longer exists.

### The rule every future tenant-owned table must follow

- The primary key, or a unique index, **leads with** `organization_id`.
- A foreign key to a parent row **carries** `organization_id`, so a child cannot
  reference a parent in a different tenant.

A bare foreign key to a parent row's id is a cross-tenant write waiting to
happen. `memberships.organization_id` plus `memberships.user_id` referencing a
global user table is the one exception, and it is safe precisely because the
tenant scope is in the key.

### Why coarse roles, not RBAC

`MembershipRole` is four values. It is not a permission graph and does not try to
become one. Fine-grained permissions are a separate decision that deserves its
own ADR. Baking a half-specified permission system into a first unreviewed
migration is exactly the speculative modelling AGENTS.md 4 rules out.

`OWNER` is not granted implicitly by `ADMIN`. Transferring ownership is a
deliberate, auditable act.

### `slug` is unique and effectively immutable

It is the stable public identifier used in routing and provisioning lookups.
Changing it breaks customer bookmarks and any provider reference captured against
it, so it is not treated as a mutable display name. `name` is the mutable label.

## Deployment safety: this change blocks production deployment

`infrastructure/scripts/deploy.mjs#assertNoMigrations` refuses to deploy any tree
whose schema declares a `model`, `enum` or `view`, or whose migrations directory
contains anything but `README.md`. This ADR and the migration satisfy both
conditions, so **every production deploy fails until the interlock is changed
deliberately.**

That is the interlock working as designed, not a bug to be worked around. ADR 0005
required it: _"Block deployment when models or migration files appear until the
SQL, backward compatibility, and controlled execution plan are reviewed."_

### Reviewed SQL

`20261014042915_tenancy_core/migration.sql` is four statements of DDL:

- `CREATE TYPE "MembershipRole"` — additive, no dependents.
- `CREATE TABLE "organizations"` — additive, empty.
- `CREATE TABLE "memberships"` — additive, empty, depends on the type.
- Indexes and the foreign key, all created with their table.

Verified against live PostgreSQL: 18 with `information_schema.columns`,
`pg_constraint` and `pg_indexes`.

### Backward compatibility

Fully backward compatible, and trivially so: every statement is additive. No
column is dropped, renamed or retyped; no existing row is read or rewritten. The
currently deployed application never queries these tables, so it is unaffected by
their existence. There is no `NOT NULL` added to an existing populated column and
no unique index built over existing data, which are the two migrations that
historically break a running deployment.

This is an **expand** with no **contract** step. The contract, if one is ever
needed, is a separate later migration after the tables are in use.

### Rollback

`DROP TABLE "memberships"; DROP TABLE "organizations"; DROP TYPE "MembershipRole";`
in that order. Safe while the tables are empty, which they are, since no
application writes to them. Once product code writes tenant data this stops being
a rollback and becomes a forward-only change.

### Execution plan, when approved

1. Back up production PostgreSQL and confirm the restore path works. A restore
   that has never been rehearsed is not a backup.
2. Apply `20261014042915_tenancy_core` with `prisma migrate deploy` from a
   controlled environment, by an operator, per AGENTS.md 12. Not from CI, not by
   hand against a database you did not create.
3. Verify the four objects exist and the migration ledger records the migration.
4. Deploy. Nothing in the application changes behaviour.

Steps 1 to 3 are supervised operator actions. CI does not run them.

## Consequences

- `migrations/README.md` is no longer accurate: there is now one migration.
- `deploy.spec.ts` still asserts that models and migrations are blocked. That
  test is **correct and must keep passing** until someone deliberately changes
  the interlock with this ADR's SQL and execution plan in hand.
- The tenancy E2E suite asserts the database itself rejects an orphan
  membership, a duplicate slug and a duplicate membership, and that cascade
  delete removes memberships. Those assertions are the reason tenant scope is
  claimable rather than aspirational.
- Every future tenant-owned table is reviewed against the rule above before it
  is added. A table that cannot satisfy it needs a written exception, not a
  quiet deviation.
