# ADR 0019: Tenant isolation at HTTP and mutation boundaries

- Status: Implemented for review; no merge or deployment authorization
- Task: RBAC-012
- Date: 2026-10-21

## Decision

Retain ADRs 0006/0009/0010: sessions identify people; path scope becomes
authorized only through fresh membership, role, current terms and suspension
checks. Organization roles never confer platform authority. Platform permissions
remain explicit on separate platform controllers; even PLATFORM_OWNER cannot
bypass membership on customer routes.

OrganizationGuard and PlatformGuard fail closed when applied without permission
metadata and reject non-HTTP contexts. Route contract tests include organization,
campaign and billing controllers. Denial diagnostics never print raw ORM errors,
request identifiers or credentials.

Campaign create/update/delete and billing profile/top-up writes now recheck the
authenticated actor at the repository transaction boundary. They acquire the
same organization row lock used by membership changes and suspension, then read
membership/active-user status and apply the existing permission registry. The
authorization SELECT is a separate READ COMMITTED statement after the lock,
so a revocation committed while waiting cannot be hidden by an old statement
snapshot. Membership and user share locks protect the accepted decision until
commit. Missing permission/membership, suspended organization and inactive user
all fail with the same 403 before any business write. No cached role is trusted.

If a mutation acquires the lock first, it may commit before a later revocation;
if revocation wins, the mutation must fail. An already authorized in-flight read
may finish; revocation prevents subsequent requests. This is a transaction
ordering guarantee, not retroactive cancellation of completed access.

## Scope and database integrity

No schema or applied migration changes are needed. Tenant-leading composite
keys and composite parent foreign keys remain authoritative for related-row
integrity. They do not automatically filter SELECTs: scoped repositories and
guarded ingress remain essential. No RLS claim is made for the database owner's
raw client. Internal SQL call persistence remains unregistered, without HTTP,
worker or webhook ingress, and accepts an already authorized tenant as specified
by ADR 0018; it must not be wired directly to an unverified payload.

Worker contains readiness/connection code only, no business processors or
scheduled jobs. No provider callback is registered. HTTP guards reject RPC
contexts, and unimplemented execution/webhook routes return 404. A future ingress
must verify its own source and derive scope from durable database relations
before calling persistence. Tests do not claim a nonexistent integration is safe.

Global identity records (users, sessions, reset tokens, terms, role assignments,
identity audits and bootstrap singleton) remain identity/platform scoped so
multi-organization membership continues to work.

## Verification and limits

The focused PostgreSQL/HTTP suite is a release blocker; it covers A/B tenants,
single/multiple/no membership, anonymous callers, forged IDs, guessed resource
IDs, query/body scope, pagination, unsupported bulk ingress, nested composite
relations, call/idempotency/redial/event isolation, concurrent retries,
revocation ordering and authorized platform exceptions. Denials may append
security audits and touch authenticated session activity; they may not mutate
business records or disclose foreign records.

Existing call history, snapshots, immutable audits/ledger, durable idempotency
and emergency-stop controls remain in force. No provider, calling, charging,
customer contact/call endpoint, frontend or infrastructure feature is added.
Billing-duration ceiling remains provisional pending Africa's Talking tariff
and charging-increment verification. Existing five development advisories remain
under review without dependency remediation.
