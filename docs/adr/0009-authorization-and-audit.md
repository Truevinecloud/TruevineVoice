# ADR 0009: Authorization model, tenant isolation and the audit trail

> Security-remediation update: see [ADR 0010](0010-rbac-001-security-transactions.md) and the [remediation report](../rbac-001-security-remediation.md). Earlier defect findings are historical; migration production approval and release dependencies remain withheld.


- **Status:** Accepted
- **Date:** 2026-10-16
- **Supersedes:** the role-model section of [ADR 0006](0006-tenancy-core-schema.md)
- **Implements:** RBAC-001 (Organization Owner)

## Context

ADR 0006 created `Organization`, `Membership` and `MembershipRole`, and was
explicit about what it was _not_ doing:

> `MembershipRole` is four values. It is not a permission graph and does not try to
> become one. Fine-grained permissions are a separate decision that deserves its
> own ADR.

This is that ADR. It makes the deferred decision.

Two further facts from the repository at the time this was written:

- `packages/auth` was an intentionally empty placeholder whose README said it
  exported nothing and must not be imported.
- There was no authentication code of any kind: no password hashing, no session,
  no guard, no user table. A repo-wide search for `argon2|bcrypt|jwt|jose|
passport|helmet|csrf|session|password` matched only prose.
- `memberships.user_id` carried **no foreign key**. The database accepted a
  membership for a user that did not exist.

That last point is the reason this ADR is not only about permissions. A tenancy
model that lets the database hold a membership to a non-existent principal is
not a tenancy model.

## Decision

### 1. Two disjoint permission namespaces, expressed in code

Organization and platform permissions are **separate string unions with no
overlap**. `OrganizationPermission` cannot name a platform permission at the type
level. This is the structural half of "an Organization Owner must never reach
platform administration"; a test asserts the runtime half.

The registry lives in **code**, in `packages/auth/src/permissions.ts`, not in
database rows. A guard that reads a permission table can disagree with the
registry the code was tested against, and nothing fails when they do — the row
is simply wrong. In code, a change is a diff and a mistake is a failing test.
The database stores _assignments_ only: a role on a membership, a role on a
platform assignment.

`packages/auth` is framework-agnostic by construction (AGENTS.md §3). It imports
neither NestJS nor an ORM. It is split into two entry points so that the
frontends can import the permission registry without pulling the native Argon2
binding into a browser bundle:

| Entry point                | Contents                                             | Safe in a browser |
| -------------------------- | ---------------------------------------------------- | ----------------- |
| `@truevine/auth`           | permissions, email, tokens, errors, audit vocabulary | yes               |
| `@truevine/auth/passwords` | Argon2id hashing                                     | **no**            |

### 2. Roles are a ladder; delegation flows strictly downward

`MembershipRole` changed from `OWNER|ADMIN|OPERATOR|VIEWER` to
`OWNER|ADMIN|CAMPAIGN_MANAGER|BILLING|VIEWER`.

`OPERATOR` became `CAMPAIGN_MANAGER`, whose name states what it is for.
`BILLING` was added because billing authority must be separately grantable and
therefore has to be expressible as a role.

> **The enum was replaced, not extended.** Both tables were empty when this was
> done (`SELECT count(*)` returned 0 on each). After real data exists this is a
> data migration with a rewrite, not a schema change.

Delegation is governed by one rule:

> **`canDelegate(actor, target)` is true only when the target's permissions are a
> _proper subset_ of the actor's.**

Both halves are load-bearing. Without the "proper" half, `OWNER → OWNER` is
allowed, assigning the owner role becomes a second and undeliberate way to create
an owner, and `ownership:transfer` — the deliberate, audited act ADR 0006
requires — is bypassed. The first implementation of this rule omitted that half
and its own test caught it.

```
OWNER  -> ADMIN, CAMPAIGN_MANAGER, BILLING, VIEWER
ADMIN  -> CAMPAIGN_MANAGER, VIEWER
CAMPAIGN_MANAGER, BILLING, VIEWER -> nothing
```

Three properties follow structurally rather than by review:

- **Billing is never inherited.** Only `OWNER` and `BILLING` hold a `billing:*`
  permission. An admin cannot grant it, because admins hold none themselves.
- **A campaign manager cannot reach ownership or membership.** They hold no
  `member:*` and no `ownership:transfer` permission at all.
- **A viewer cannot mutate.** `MUTATING_ORGANIZATION_PERMISSIONS` is _derived_
  from the registry by filtering `!permission.endsWith(':read')`, not
  hand-maintained — a hand-maintained list drifts, and a viewer or auditor
  silently gains a mutating permission.

### 3. Ownership is transferred, never assigned

`OWNER` is not a delegable role. It exists only through
`POST /organizations/{id}/ownership/transfer`, which is a compare-and-set in one
transaction: if two owners act at once, exactly one sees its own id and the
other is refused rather than silently overwriting.

The previous owner becomes an `ADMIN` rather than losing access. The person who
ran the organization usually still works there, and silently deleting their
membership would be surprising and destructive.

The database refuses to leave an organization ownerless by two independent
means: `changeMembershipRole` refuses to demote an existing `OWNER`, and
`removeMembership` refuses to remove the last one — both counted _inside_ the
transaction that performs the write. A service-level "count the owners, then
update" would be a check-then-act race that two concurrent requests both pass.

### 4. Tenant isolation is enforced at the path, validated against the session

`OrganizationGuard` runs this order, and the order is the design:

1. Read the organization id from the **path** only.
2. Load the session principal's membership in _that_ organization.
3. Refuse if there is no membership.
4. Refuse if the current terms version is unaccepted, when the route requires it.
5. Refuse if the role does not hold the required permission.

A client-supplied organization id is never trusted. It is only ever a _claim_
about which tenant the caller wants; step 2 turns it into a fact or leaves it a
claim. A forged path, a forged body field and a guessed resource id all fail at
the same place, because the body is never read for an identifier and the guard
authorizes the _organization_, not the row.

Routes declare their requirement with `@RequireOrganizationPermission(...)` and
the guard reads it. There are no inline checks in any controller: an inline check
is one somebody forgets to update when the route changes.

**403, not 404.** A caller with no membership receives the same 403, with the
same body, as a caller naming an organization that does not exist. A 404 would
confirm that the tenant is real, which is itself information a competitor is
entitled to neither have nor be able to confirm.

### 5. Identity tables are not tenant-owned

`User`, `Session`, `PasswordResetToken` and `TermsAcceptance` are keyed by
`user_id`, not by `organization_id`.

ADR 0006's rule is that **tenant-owned** rows lead with `organization_id`. A
person is not a tenant resource: the same individual may belong to several
organizations with independent roles. Keying identity tables by organization
would make that impossible. `Membership`, `Invitation` and `SecurityAuditEvent`
_are_ tenant-owned and do follow the rule.

The session is deliberately **not pinned to an organization**. It proves _who_ is
calling; which organization they are acting in comes from the request and is
validated against a membership every time. Pinning would let a stale cookie act
in a tenant the user has since left.

### 6. Credentials

- **Passwords** are Argon2id at OWASP's current parameters (19 MiB, t=2, p=1).
  The library exports its algorithm as an ambient `const enum`, which
  `isolatedModules` forbids referencing, so the numeric value is documented and
  proven by a test that asserts every produced hash begins `$argon2id$` and that
  `verifyPassword` refuses anything that does not. A wrong constant fails a test
  rather than silently downgrading to Argon2i.
- **Session, invitation and reset tokens** are 256 bits of CSPRNG output. The raw
  value exists only in the client's cookie or the emailed link; the database
  stores `sha256(token)`. A database disclosure therefore yields no usable
  credential. The digest is a lookup key, not a secret, so SHA-256 rather than
  Argon2 is correct: the input already has full entropy.
- The password hash is stored in `users.password_hash`, not `users.password`, so
  a careless `select *` into a response body cannot ship it under an obvious
  name.

### 7. No account enumeration, anywhere

A wrong email, a wrong password, a malformed address, and a password-reset
request for an unregistered address are **indistinguishable**: same status, same
message, comparable timing. An unknown user is verified against a real Argon2id
hash of a value nobody knows, so "no such user" does not return in microseconds
while "wrong password" returns after 50 ms of real work.

Rate limiting is per IP prefix rather than per account: per-account limiting lets
an attacker spray one account from many addresses. The limiter **fails closed** —
if Redis is unreachable the answer is "no", because "we could not check" must
never mean "unlimited".

### 8. Cookie sessions, CSRF, and no client-side token storage

The session is an HTTP-only `Secure` `SameSite=Lax` cookie. `SameSite=Lax` rather
than `strict` because a password-reset link is followed from an email and
`strict` would strip the cookie on the navigation that completes it.

`SameSite` alone is **not** treated as sufficient. Cookie-authenticated mutations
carry a double-submit CSRF token: a readable cookie the client echoes in the
`x-truevine-csrf` header. The token is issued by middleware on any request
arriving without one, because the first mutation for an anonymous visitor _is_
sign-in and a token handed out by the sign-in response arrives too late.

**The session token is never placed in `localStorage`, `sessionStorage`, or any
script-readable store.** An `HttpOnly` cookie is the only reason an XSS payload
cannot exfiltrate the session, and moving the token to JavaScript to satisfy a
client-side API would give that capability back.

### 9. The audit trail is append-only, in two tables, enforced by the database

**Two tables, deliberately.** `security_audit_events` is tenant-owned and leads
with `organization_id`. Identity events — sign-in, password reset, terms
acceptance, session revocation — are facts about a _person_ and belong to no
organization, so they live in `identity_audit_events`.

The alternatives were both rejected explicitly:

- A nullable `organization_id` on the organization trail. Prisma cannot put a
  nullable column in a primary key, so this would have meant weakening the
  ADR 0006 composite-key rule that keeps every tenant-owned table tenant-scoped.
- One row per membership. A user in two organizations would get two "signed in"
  rows, and a user in none would get none at all — the trail would under-report
  precisely when it matters most.

**Immutability is a trigger, not a `REVOKE`.** The application connects as the
table's owner, and a table owner bypasses its own grants, so
`REVOKE UPDATE, DELETE` would be decorative. A `BEFORE UPDATE OR DELETE` trigger
that raises is the only mechanism that holds against a careless future query, a
direct `psql` session, or an ORM call nobody reviewed.

**Denials are recorded**, not only successes. A trail of successes cannot answer
"was this an attack?".

`action` is a `varchar`, not an enum, because the set of audited actions grows
with the product and a new action must not require migrating an immutable table.
The vocabulary lives in `AUDIT_ACTIONS` and the writer calls
`assertKnownAuditAction`, so a typo fails the request rather than producing a row
nobody can query. Metadata keys are checked against a forbidden-credential list
for the same reason.

### 10. Consequences of append-only, recorded rather than hidden

Each of these blocks a real operation, so each is asserted by a test and recorded
here rather than left to be discovered:

| Consequence                                                                                        | Why                                                                  | Status                                                                                                              |
| -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| An organization with audit events **cannot be deleted**; the `ON DELETE CASCADE` fires the trigger | deleting a tenant must not destroy the record of what happened in it | Tenant removal must become a **soft delete**. No status column exists; nothing in RBAC-001 deletes an organization. |
| A user who has acted **cannot be deleted** (`actor_user_id` is `ON DELETE RESTRICT`)               | same                                                                 | A right-to-erasure procedure must **anonymise**, not delete. **No such procedure exists.**                          |
| Test fixtures that generated audit history cannot be cleaned up                                    | same                                                                 | Fixture identifiers are unique per run.                                                                             |

## Unresolved questions

These are recorded, not answered. This ADR deliberately does not invent policy.

### Legal and regulatory

- **Retention period for audit events.** No retention policy is defined. Audit
  rows cannot be deleted by the application, so "delete after N years" is
  currently impossible without a privileged DBA action that bypasses the trigger.
  Whether GDPR/PDPA-style erasure rights override audit retention, and how the
  two are reconciled, is a legal question with a technical consequence that must
  be decided before the first customer, not after.
- **Lawful basis and privacy notice** for processing team members' email
  addresses and IP prefixes. `sessions.ip_prefix` is truncated to /24 and
  `user_agent_hash` is a digest precisely to reduce this, but the fields are still
  personal data.
- **Cross-border transfer** of audit metadata, which includes actor identifiers.
- **Data subject access** must be answerable: what organizations is this person
  in, what did they do, what sessions were opened. No tooling exists to produce
  that export.

### Product

- **Username as a login identifier.** Email is the sole identifier today, which
  means an email change is an identity change. Whether a separate username is
  required is undecided and needs a product call.
- **Invitation expiry.** Seven days is a placeholder, not a reviewed value.
- **Terms content.** `TERMS_VERSION` is a constant and `GET /auth/terms` returns
  an empty URL. **No terms document exists.** Acceptance is enforced against a
  version string with nothing behind it, which is a real gap: a user can accept
  terms that do not exist.
- **Account deactivation vs deletion.** A `SUSPENDED` status exists and is
  enforced at sign-in, but no administrative action sets it. There is no
  self-service deactivation.

### Operational

- **Email delivery is not implemented.** Reset and invitation tokens are created
  and stored; nothing sends them. An SMTP or transactional-email credential does
  not exist in this repository and must not be added to one.
- **Platform-scoped audit for denials by callers with no organization.** See
  below.

## Known limitations of the audit design

Stated plainly rather than left for someone to discover.

**A cross-tenant attempt is recorded against the _targeted_ tenant**, not the
attacker. `organization_id` is `NOT NULL` with a foreign key, and a caller who
belongs to no organization — the case most worth recording — has no organization
of their own to file it under. The targeted tenant is the party with a
legitimate interest in knowing they were probed, and the row records the actor so
they can see who it was. The cost is that a probe writes a row into an audit
trail belonging to an organization the caller is not a member of. This is a
defensible trade, not a free choice.

**A platform-scoped denial by a caller with no organization context is not
recorded at all.** There is no row to write it into, and inventing one would
either violate the `NOT NULL` constraint or fabricate a tenant association.
Closing this requires a platform-scoped audit table, which is RBAC-002 work.

**Audit failure never changes the response, but is no longer silent.** If the
audit sink is unavailable the request still receives its correct 403 or 401, and
the failure is written to stderr with the organization and the underlying error.
The alternative - failing closed on audit unavailability - would turn an
observability outage into a total outage. This is a deliberate trade with a
known cost: a refusal can occur with no corresponding row.

The most common cause of that failure is worth naming, because it is a design
consequence rather than a fault. A denial against an organization id that **does
not exist** cannot be filed: `security_audit_events.organization_id` is `NOT
NULL` with a foreign key, and there is no tenant to file it under. Skipping such
a row is semantically correct - nobody was targeted, so nobody needs telling -
but it means a flood of probes against non-existent ids writes no rows at all.
The stderr line is what distinguishes this normal outcome from a genuine audit
outage.

## Account and organization lifecycle

Both are **suspension, never deletion**. The reason is the append-only rule rather
than a preference: `security_audit_events` cascades from `organizations` and
restricts on `users`, so deleting either is refused by the database once it has
audit history. A destructive "close" would therefore fail for exactly the
organizations most likely to need closing.

**Account deactivation** sets `status = SUSPENDED`, destroys every live session,
and records `auth.account_deactivated` with `reversible: true`. It also clears
the failure counter and lockout, so a reactivation is not blocked by the lockout
that preceded it. There is deliberately **no "reactivate me" button**: an account
a user could switch off and on at will would make suspension meaningless as a
response to abuse. Reactivation goes through the password-reset flow, which
requires proof of control of the address.

**Organization suspension** sets `organizations.suspended_at`, checked by
`OrganizationGuard` *before* the permission lookup. Order matters: an Owner holds
every organization permission that exists, so a check placed after the permission
lookup would wave a suspended tenant straight through. The denial is audited with
`reason: 'organization_suspended'`, so an operator can tell a suspension from a
permission mistake. Reversibility is covered by a test: an Owner is refused while
suspended and served normally once the column is cleared.

**Who may suspend an organization is deliberately not implemented.** Suspending a
tenant is a platform-authority action, and RBAC-001 has no platform role. Adding
an HTTP route would mean inventing an authority model that belongs to RBAC-002.
The mechanism and its enforcement exist; the caller identity is deferred.

**Personal-data erasure needs a policy decision before it can be implemented.**
Deletion is blocked by design, so erasure must be **anonymisation**: overwrite the
identifying fields, keep the row, keep the audit trail. That raises questions this
ADR cannot answer — what "identifying" covers for a user who was both a member
and an audit actor; whether audit rows containing their user id must themselves be
scrubbed or retained under a legitimate-interest basis; and what retention period
applies to each. Fabricating an answer here would be worse than leaving it open.

## Consequences

- `MembershipRole` is replaced. Non-destructive only while the tables are empty.
- Every tenant-owned table added later must repeat the ADR 0006 shape: composite
  key or unique index leading with `organization_id`, and foreign keys that carry
  the organization alongside the parent id.
- `infrastructure/migrations-reviewed.json` does **not** list any of the RBAC-001
  migrations, so production deployment remains blocked by design. Listing them is
  a human act that requires reviewing each migration's SQL, backward
  compatibility, rollback and execution plan.
- RBAC-002 and later must add platform permissions to the registry without
  weakening the namespace separation, and must not introduce unrestricted customer
  impersonation or enterprise custom roles.
