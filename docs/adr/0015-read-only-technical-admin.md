# ADR 0015: Read-only Technical Admin platform role

- Status: Accepted for implementation; production deployment approval not granted
- Date: 2026-10-21

## Context

The platform permission registry already defined a `TECHNICAL_ADMIN` platform
role and a `platform:technical:write` permission, but no technical API, admin
workspace or test covered them. The role is intended for on-call engineers who
need to see provider integration status, queue/job health, log availability,
technical diagnostics and the platform audit trail, without any ability to
mutate platform state.

Two tensions had to be resolved: a read-only role that forgot to exclude
mutations would be a privilege-escalation path, and every domain the platform
cannot yet report on (voice providers, business queues, a log store) had to be
presented honestly rather than as an empty result that reads as "there were
none".

## Decision

- `TECHNICAL_ADMIN` holds exactly `['platform:technical:read',
  'platform:audit:read']`. `platform:technical:write` stays in the vocabulary
  but is granted to `PLATFORM_OWNER` only, reserved for a future technical
  mutation that does not exist yet. This keeps the read/write split explicit
  and testable without inventing a mutation endpoint.
- Every technical route is `GET` under `platform/technical`. No write method is
  exposed, so no CSRF surface is added. Guards are `SessionGuard`,
  `TechnicalRateLimitGuard`, `PlatformGuard`, in that order: the rate limit runs
  before the permission check so that denied probing is still counted.
- Reading a domain is itself an auditable act. Each view is recorded before the
  response is returned, fail-closed through the identity audit store: if the
  event cannot be written, the request fails rather than returning unlogged
  diagnostic data. `me` is not audited, matching the support and operations
  workspaces.
- The audit trail merges two tables: identity events and
  `security_audit_events` rows with `scope = 'PLATFORM'` only. Organization-
  scoped security rows are excluded by the store query itself, so tenant
  isolation lives with the query rather than in a controller. Events are merged
  newest-first by `(occurredAt desc, id desc)` and paginated with an opaque
  `${trail}:${uuid}` cursor.
- The API reports a subsystem's absence explicitly - `not_integrated` for a
  declared-but-unlinked provider or an unregistered queue system, and
  `not_configured` where there is no log store - and names the domains that are
  not modelled at all. It never scans Redis keys to synthesise queue data for a
  subsystem that does not exist.
- The admin app proxies only the technical read routes, following the existing
  same-origin proxy. API guards remain the authorization boundary; hiding a
  section in the UI is not authorization.

## Consequences

No database migration is required: the feature reads existing audit tables and
process health only. Because no technical mutation exists, the role is safe to
grant without a compensating write-path review; adding one later requires its
own decision and audit action.

The merged trail depends on two independent tables and their ordering; the unit
and E2E suites pin the merge order, cursor format and scope filtering. The real
PostgreSQL E2E suite is required before release, as the merge cannot be verified
against fakes alone.

The role is read-only and the routes are `GET`, so production access is limited
to observation. This task does not modify production data, grant the role to any
live account, merge or deploy.
