# ADR 0010: RBAC-001 transaction and database security invariants

- Status: Accepted for implementation; production migration approval withheld
- Date: 2026-10-16
- Supersedes: ADR 0009's transaction, single-Owner, reset replay and recovery claims

## Decision

Security mutations and their success audits use one PostgreSQL transaction. The
auth module exports `SECURITY_TRANSACTION`; services retain business decisions
and receive transaction-bound structural stores, while controllers remain HTTP
only. The transaction adapter does not own another connection or process. Argon2
work runs before row locks; email delivery runs outside password-reset issuance's
transaction. A delivery success is not inferred from an audit event.

All organization mutations lock the organization row and re-read actor authority
inside that lock. Membership changes, removal and transfer use the same lock.
Transfer demotes the old Owner and promotes the new Owner in one transaction.
A partial unique index prevents multiple Owners, and deferred constraint triggers
require exactly one Owner at commit, including direct SQL. Organization creation
and its first Owner must therefore commit together; ownerless organizations are
no longer a supported persisted intermediate state.

Invitation acceptance resolves tenant scope from the opaque token, verifies the
active authenticated email identity, then conditionally consumes the invitation
before upserting membership. The claim checks unused, unrevoked and unexpired
state and carries organization scope. The enclosing transaction includes the
success audit. Rejection leaves no new membership. Database triggers bind accepted
identity and require new invitation authors to belong to the target organization.
Historical invitations may survive later member removal. OWNER invitations are
forbidden in the database. Inviting/accepting existing authenticated identities
is the supported security contract; public registration/new-invitee account
creation is not introduced by this remediation.

Authentication mutations lock the user row. Failed sign-ins update the durable
counter and fixed temporary lockout in PostgreSQL. Calls arriving while locked
do not extend that deadline; the next failed attempt after expiry starts a new
window. Correct credentials work again after expiry. Locked/suspended/unknown
accounts have the same invalid-credentials response, and password verification
still runs. IP-prefix rate limiting remains fail-closed. Successful session
creation rechecks the verified hash under the same user lock, fencing concurrent
password reset/deactivation.

Password reset re-reads token state under that user lock, then commits token
consumption, hash replacement, other-token invalidation, all old-session
revocation and success audit atomically. Hashing occurs before locking. Database
errors roll back the entire operation. Replayed tokens only produce a denial
audit: they cannot change a password or repeatedly revoke newly issued sessions.
This intentionally removes the spent-token account-denial capability described
in ADR 0009. Sessions still live before a successful reset are always revoked.

Successful profile, membership, invitation, ownership, sign-in, sign-out, terms
and deactivation actions have transactional audit records. Business refusals are
recorded as DENIED after rollback, or returned from the transaction before the
HTTP error is raised, so no false SUCCESS survives a failed mutation. Database
audit failures fail the mutation closed. Existing unknown-tenant/platform denial
limitations remain; no fabricated tenant or RBAC-002 audit system is added.

Current terms are required on every customer organization route, including
invitation acceptance. `/me` remains caller discovery; authentication, terms
retrieval/acceptance, password recovery, sign-out and self-deactivation are
explicit exceptions. A handler coverage test detects missing future annotations.
The empty legal-document URL remains a production blocker, not valid consent.

SUSPENDED remains a security suspension. Password reset must not automatically
unsuspend an account; operator recovery policy is a release prerequisite. Earlier
text claiming self-deactivation is recoverable by reset is withdrawn. No platform
reactivation endpoint or administrative role functionality is added.

## Migrations and rollout

`20261016170000_security_atomicity` validates existing Owner counts and accepted
invitation identity/shape before adding constraints, in an explicit transaction.
Any inconsistency produces an actionable exception and zero automatic repairs.
`20261016171000_invitation_origin` adds the insertion-time author scope trigger
separately because the prior migration had already been rehearsed. No applied SQL
was edited. Both remain outside `migrations-reviewed.json`.

The currently deployed foundation has no identity writers. Before any production
approval, independently establish the target dataset, privileges, backup/restore,
locks and rollback/forward recovery plan for all six unapproved migrations. For
an environment already running old RBAC writers, upgrade/stop those writers
before adding the unique index: the old promote-first transfer order is
incompatible. New code's lock/demote/promote order can run before the constraints
are applied, but database-level guarantees require those constraints.

The exactly-one-Owner trigger and partial index are deliberate SQL-owned
constraints not represented as a normal Prisma model unique. Retain and inspect
them when generating subsequent migrations. Do not approve drift that drops them.

## Verification and consequences

`npm run test:security:baseline` freezes the reviewed pre-fix store from
087b190 and runs the same race assertions on a disposable pre-remediation schema;
the command is expected to fail with two genuine security failures. It is not a
green gate or a skipped test. `npm run test:security` uses newly created databases
only, rehearses migration success/refusal and executes every integration suite.
No existing development database is reset or migrated by this runner. It removes
only database names generated and recorded by that invocation.

Real PostgreSQL tests repeat store and HTTP races, check constraint enforcement,
and inject actual audit INSERT failures to prove rollback. The fixed IP limiter
is replaced only in the focused HTTP fixture so it does not obscure these DB
invariants; per-account protection is real and shared by independent clients.
The worker/infrastructure integration tests still use the actual Redis service.

The expected wire lifetime of both cookies is 12 hours; Express options use
milliseconds. Malformed percent encoding is a missing credential, and CSRF
comparison uses timingSafeEqual. Prisma remains aligned at 7.10.1. ESLint remains
10; unsupported downgrade/peer suppression is not part of the decision.
