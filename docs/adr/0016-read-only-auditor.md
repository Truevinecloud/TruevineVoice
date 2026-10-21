# ADR 0016: Read-only Auditor platform role

- Status: Accepted for implementation; production deployment approval not granted
- Date: 2026-10-21

## Context

The platform permission registry already defined an `AUDITOR` platform role, but
no audit API, admin workspace or test covered it. The role exists to answer one
question - "what did operators do to the platform?" - for an internal or external
reviewer, and to do nothing else. Its defining risk is the opposite of most
roles': it is not a role that might have too little access, but one that might
quietly gain too much, because custody of the audit trail is easily mistaken for
custody of everything the trail describes.

Two tensions had to be resolved: a read-only role that forgot to exclude
mutations would be a privilege-escalation path, and the audit trail merges two
tables (identity events and platform-scoped security events) that must not leak
organization-scoped rows to a role that is not a support function.

## Decision

- `AUDITOR` holds exactly `['platform:tenant:read', 'platform:operations:read',
  'platform:support:read', 'platform:audit:read']`. It holds no `:write`,
  `:suspend`, `:refund`, `:diagnostics` or `:manage` permission. The permission
  registry tests pin the row literally, so widening it is a deliberate edit.
- Every auditor route is `GET` under `platform/audit`. There is no POST, PUT,
  PATCH or DELETE in the controller, so "cannot mutate" is enforced by the
  absence of a route rather than by a runtime check that could be removed. No
  CSRF surface is added. Guards are `SessionGuard`, `AuditRateLimitGuard`,
  `PlatformGuard`, in that order: the rate limit runs before the permission check
  so denied probing is counted.
- Reading a domain is itself an auditable act. Each view is recorded before the
  response is returned, fail-closed through the identity audit store: if the
  event cannot be written, the request fails rather than returning unlogged data.
  `me` is not audited, matching the support, operations and technical workspaces.
- The audit trail merges two tables: identity events and
  `security_audit_events` rows with `scope = 'PLATFORM'` only. Organization-scoped
  security rows are excluded by the store query itself, and the store re-checks
  the scope in the mapper and throws if a non-platform row ever reaches it - so
  the tenant-isolation guarantee does not depend on a single `where` clause
  surviving future edits. Events are merged newest-first by `(occurredAt desc,
  id desc)` and paginated with an opaque `${trail}:${uuid}` cursor.
- Every response is assembled field by field from a structural store interface
  that has no billing, wallet or credential field to name. Metadata is projected
  through a key allowlist and a scalar-shape filter before it leaves the service,
  so a field written by a future writer cannot leak by default.
- The admin app proxies only the auditor read routes, following the existing
  same-origin proxy. API guards remain the authorization boundary; hiding a
  section in the UI is not authorization.

## Consequences

No database migration is required: the feature reads existing audit and tenant
metadata tables only. Because no auditor mutation exists, the role is safe to
grant without a compensating write-path review; adding one later requires its own
decision and audit action.

The merged trail depends on two independent tables and their ordering; the unit
and E2E suites pin the merge order, cursor format, scope filtering and the
metadata projection. The real PostgreSQL E2E suite is required before release, as
the merge cannot be verified against fakes alone.

The role is read-only and the routes are `GET`, so production access is limited
to observation. This task does not modify production data, grant the role to any
live account, merge or deploy.
