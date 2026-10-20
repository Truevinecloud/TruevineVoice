# ADR 0013: Platform Operations Admin emergency stops

- Status: Accepted for implementation; production deployment approval not granted
- Date: 2026-10-20

## Context

The platform permission registry already defines `OPERATIONS_ADMIN` separately
from organization roles. The API guard checks that platform role on every
request. The platform-admin app was still a placeholder, and no operations API
existed. Campaign records are implemented; voice providers, call dispatch and
active-call controls are not.

## Decision

- Operations Admin reads organization status and campaign summaries through
  platform-only routes. Queries return organization metadata and campaign data,
  never customer identities, credentials, billing or wallet data.
- Emergency stop is a platform operation scoped to an explicit
  `(organizationId, campaignId)` composite identity. It stores COMPLETED plus
  an immutable stop marker; the API presents that combination as PAUSED. This
  keeps the stored enum readable by the deployed client during rollback. A DB
  trigger prevents older application code from clearing the marker or moving
  the campaign back to ACTIVE or delete it. No resume or marker-clearing
  endpoint is added.
- The campaign mutation and its `platform.campaign.emergency_stopped` audit row
  commit in one PostgreSQL transaction. The event is written to the target
  organization's existing append-only security audit table with `scope =
PLATFORM`; this preserves the non-null organization foreign key and makes the
  affected tenant identifiable. Audit metadata contains only an allowlisted
  reason code, never free-form operator text.
- The Operations Admin role keeps its existing explicit permission set. This
  feature adds no billing, refund, pricing, platform-role-management or
  technical-admin permission.
- The operations health endpoint reports API, PostgreSQL and Redis health. It
  reports voice provider status as `not_integrated`. Emergency stop applies to
  the campaign record only. It must never claim to stop a voice call or provider
  dispatch until that capability is implemented behind the telephony interface.

## Consequences

The additive migration adds the emergency-stop timestamp column and a database
trigger. The migration remains absent
from `infrastructure/migrations-reviewed.json`; it requires disposable-database
success/failure and recovery rehearsal, CI, review, and explicit operator
approval before any controlled deployment. Application rollback does not erase
the stop marker or audit history. A stopped campaign needs a separately reviewed
recovery procedure; this change intentionally offers no in-product restart.

The admin app requires `TRUEVINE_API_URL` to point at the API origin and proxies
only the sign-in/out and platform-operations routes. Its same-origin proxy
forwards the existing secure session and CSRF cookies. API guards remain the
authorization boundary; hiding an action in the UI is not authorization.

## Verification boundary

Unit and HTTP tests cover permission denial, scoped updates, stop state and audit
atomicity. The real PostgreSQL E2E suite is required before release. This task
does not modify production data, approve a migration, merge or deploy.
