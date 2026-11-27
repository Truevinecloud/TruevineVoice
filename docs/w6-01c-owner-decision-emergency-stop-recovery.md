# W6-01C owner-decision paper: emergency-stop recovery

Date: 2026-11-25

**Status: assessment only. No recovery model is approved for implementation. ADR 0013 and ADR 0032 remain authoritative.**

## Decision requested

Owner direction is requested on whether a future, narrowly scoped emergency-stop recovery capability should be designed, and if so under which authority model. This document does **not** authorize endpoints, permissions, roles, migrations, UI controls, marker clearing, campaign restarts, automatic provider calls or deployment.

## Findings

- `emergencyStoppedAt` is a **campaign-specific, tenant-scoped** field on `Campaign`. Platform authorization is global, but there is no platform-wide or organization-wide stop marker.
- The only stop route is `POST /platform/operations/organizations/:organizationId/campaigns/:campaignId/emergency-stop`.
- Existing controls are `SessionGuard`, `PlatformGuard`, `CsrfGuard`, `RequirePlatformPermission('platform:operations:write')`, `authorizeEmergencyWrite()`, the shared campaign advisory lock, and append-only sensitive audit records with `platform.campaign.emergency_stopped`.
- No recovery/re-enable route, permission, role, audit action, proxy entry, UI control, migration, script or state transition exists.
- A stopped campaign is terminal under ADR 0013/0032. Previously accepted calls are reconciled; they are never replayed.

## Options

| Option | Security | Financial | Operational | Architecture | Assessment |
| --- | --- | --- | --- | --- | --- |
| **A — Dedicated two-actor recovery, no automatic restart** | Strongest: a dedicated permission, an explicitly authorized platform role, two distinct authenticated actors, no self-approval, existing sensitive-action authentication, immutable audits and a mandatory justification. | Safest MVP: recovery changes only whether new paid work is blocked; it does not release reservations, mutate the ledger or invoke a provider. | Slower by design; requires an incident record and a second operator. Clear accountability for incidents. | Adds one bounded capability behind existing guards and an incident record referencing the original stop audit. | **Preferred MVP direction only.** Requires explicit owner approval before any design or implementation. |
| **B — Single-actor re-enable with existing operations write permission** | Weak: one actor could clear the stop they or a peer applied; no independent check against coercion or mistaken stop. | A mistaken re-enable could permit new reserved paid work without an incident record. | Fast, but no defensible audit story for regulated or high-value incidents. | Smallest code change, but concentrates irreversible authority in one role. | Rejected. Conflicts with ADR 0032 two-actor model. |
| **C — No recovery; keep every stop terminal** | Strongest containment. | No new financial exposure. | Requires replacement campaigns for genuine mistakes; retains incident history but adds operator overhead. | No new surface. | Acceptable interim posture and the default until an owner approves A. |

## Preferred direction, subject to formal approval

If recovery is ever authorized, Option A should be the MVP direction with all of the following as non-negotiable requirements:

1. A dedicated emergency-recovery permission, separate from general operations write.
2. An explicitly authorized platform role; no implicit inheritance from support, technical, billing or tenant roles.
3. Two distinct authenticated platform actors: requester and approver. Self-approval must be rejected.
4. Existing sensitive-action authentication and CSRF on both actions.
5. A durable incident record referencing the original `platform.campaign.emergency_stopped` audit.
6. A mandatory justification for both request and approval, recorded immutably.
7. No automatic restart, provider invocation, dispatch-state mutation, marker clearing outside the approved transaction, or reservation release.
8. The shared advisory lock and pre-provider guard remain authoritative; recovery cannot bypass them.
9. All audits remain append-only and include actor IDs, timestamps, campaign and organization scope, before/after state, and the original audit reference.

## Decision

Owner approval is **not recorded**. W6-01C therefore implements no recovery interface. `W6-01 not production-ready` remains the status.
