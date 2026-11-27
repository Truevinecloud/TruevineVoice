# ADR 0032: W6-01 campaign dispatch reliability and emergency-stop amendment

- Status: Draft amendment to ADR 0013 and ADR 0028; implementation and isolated-test proposal only. No production deployment approval.
- Date: 2026-11-24
- Supersedes: nothing. ADR 0013 remains accepted; this record adds the dispatch boundary it did not yet have.

## Context

ADR 0013 made a platform emergency stop terminal at the campaign-record level.
It deliberately offered no restart because voice dispatch did not exist. W4/W5
then added durable call attempts, provider-idempotent initiation, reconciliation
and usage settlement. Those features create a new question ADR 0013 did not
answer: what exactly stops when an operator presses emergency stop, and how do
we prove that no new **paid** provider work begins afterwards?

The existing worker checked `campaign.status === 'PAUSED' | 'CANCELLED'` and
`campaignExecution.status`, but those values are not persisted lifecycle states.
The worker also never read `emergencyStoppedAt`. An emergency stop therefore
changed the API presentation without stopping dispatch. There was no
authoritative balance check immediately before `voice.initiateCall()`, and the
operations response reported `voiceDispatchStopped: false`.

§11 and §31 of the product specification are unavailable in this workspace.
This decision is based on the W6-01 workplan row, the approved ADRs, and the
existing code contracts. No tariff or reserve policy is approved in the
repository, so none is invented here.

## Decision

### 1. Additive dispatch state, separate from campaign record status

Campaign rows gain `dispatch_state`, `dispatch_epoch`, `paused_at`,
`cancelled_at` and `dispatch_stop_reason`. They are stored as text with database
check constraints so an older client that does not know the columns remains
deployable. Existing rows default to `RUNNING`; rows already carrying an
emergency-stop marker become `CANCELLED` in the migration.

Database constraints and triggers make the following illegal:

- decreasing the dispatch epoch;
- restarting a `CANCELLED` campaign;
- setting `dispatch_state = RUNNING` while `emergencyStoppedAt` is set.

The emergency-stop transaction still writes the immutable marker and its audit
row in one transaction. A second trigger marks dispatch cancelled in the same
statement. The marker is never cleared by this work.

### 2. One shared stop boundary

A campaign stop mutation and a paid provider invocation take the same PostgreSQL
advisory lock, keyed by `(organizationId, campaignId)`. The lock is held in the
worker transaction until after the provider response is durably recorded. A
stop cannot commit while a call is starting; no invocation can begin after the
stop transaction commits. The wallet balance lock is taken with the same key
format already used by settlement and adjustments.

### 3. The authoritative pre-provider guard

Immediately before `voice.initiateCall()`, inside the same transaction that
records the provider operation, the worker re-reads PostgreSQL and refuses the
call if any of these is true:

- the campaign is not `ACTIVE`;
- `dispatch_state` is `PAUSED` or `CANCELLED`;
- `emergencyStoppedAt` is set;
- the organization is suspended;
- the approved cost policy is absent or returns an invalid reserve;
- available wallet balance minus durable held reservations is below the
  reserve.

Redis, a BullMQ payload, an in-memory flag and a prior worker decision are never
trusted at this boundary. A queued, delayed or retrying job must pass this guard
every time. An optional `dispatchEpoch` in the job payload lets a job created
before a pause/resume be refused without relying on queue deletion.

### 4. Reserve policy and low balance

A narrow `DispatchCostPolicy` interface returns an exact integer minor-unit
reserve with a currency and a policy version. Production has no implementation
and fails closed; an isolated fake-provider environment injects a synthetic
fixed reserve. No tariff is inferred from call direction, duration or provider
name.

A reserve is a durable coordination row in `campaign_dispatch_reservations`,
**not** a wallet entry and **not** a financial event. It is created before the
provider call, settled in the same transaction as usage settlement, or released
when no provider call occurred. Insufficient balance pauses the campaign with
reason `insufficient_balance`; a missing policy pauses with
`dispatch_policy_unavailable`. Both are explicit, auditable reason codes.

### 5. Customer pause, resume and cancel

Authenticated organization members with the explicit `campaign:pause`,
`campaign:resume` and `campaign:cancel` permissions may act on an `ACTIVE`
campaign through tenant-scoped endpoints. Pause and resume are reversible for a
customer-paused campaign; cancellation is terminal. None of these actions can
clear an emergency marker or restart an emergency-stopped campaign. Every
transition increments the epoch and writes an append-only sensitive-action
audit row with a server-owned reason code.

Resume means "resume customer-paused dispatch", not "clear a platform stop". It
does not promise that a previous campaign reached any particular call count, and
replayed initiation keys prevent a second provider call for an attempt that was
already invoked.

### 6. Platform re-enable proposal (not implemented)

An emergency stop remains terminal under ADR 0013. This ADR proposes, but does
not implement or approve, a separate explicit re-enable flow with all of the
following properties:

- a new platform permission, distinct from `platform:operations:write`, granted
  only to a deliberately named platform role;
- a second platform actor's authorization recorded against the same stop
  incident before dispatch may be restored;
- a durable incident/override record that references the original audit event;
- a new `dispatch_state` transition through an "authorized" state rather than
  clearing `emergencyStoppedAt`;
- a new, separately reviewed migration added to
  `infrastructure/migrations-reviewed.json` after disposable-database rehearsal.

Until that flow is accepted and deployed, no API, UI, script or migration in this
change re-enables an emergency-stopped campaign. A restart requires a reviewed
manual recovery procedure, as ADR 0013 already states.

### 7. Exact work boundary

| Phase | What is durable | Effect of a stop |
| --- | --- | --- |
| Queued | Job in Redis only; no business fact | Job may still be dequeued, but the guard refuses it |
| Reserved | `campaign_dispatch_reservations` row HELD and reconciliation NOT_STARTED | No further paid work; reservation released if the transaction rolls back |
| Provider invocation | Reconciliation INVOKING; advisory locks held | Stop waits for the lock, then commits; already-started call may complete |
| Provider acceptance | Idempotent `call_operations` row and reconciliation CONFIRMED | Preserved; never replayed as a new provider call |
| Completed | Append-only ledger entry and settled call events | Preserved; no reversal is promised |
| Uncertain | Reconciliation UNKNOWN with `reconciliationRequired = true` | Reconciliation continues after stop, restart and cancellation |

An in-flight call is acknowledged honestly: a stop prevents **new** paid
provider work from crossing the boundary after the stop boundary commits. It
does not cancel a call the provider already accepted, reverse a charge, or
delete call history.

## Consequences

- The dispatch guard is the only place allowed to start paid provider work, so
  the proof target is a fake-provider invocation counter, not a campaign status.
- Development without an approved cost policy fails closed. Existing local
  fake-provider tests must opt into a synthetic policy explicitly.
- `campaign.status` remains the legacy record status for rollback compatibility.
  Presentation layers must read the explicit dispatch fields to describe
  pause/cancel reasons accurately.
- The W6-01 migration is a proposal only. It is intentionally **not** listed in
  `infrastructure/migrations-reviewed.json` by this change.
- Customer-facing pause/cancel actions and platform-admin stop visibility are
  wired to the existing interfaces. No platform re-enable control is added.

## Verification boundary

Verification requires an isolated PostgreSQL database and Redis namespace with
a synthetic voice adapter. Tests assert fake-provider invocation counts for
paused, cancelled, emergency-stopped, insufficient-balance, concurrent-overspend,
delayed, retried, restarted and stale-epoch paths. Reconciliation and duplicate
callback tests assert that accepted calls settle once. Authorization and audit
tests assert tenant scoping and sensitive-action records. No production
database, live provider, payment, callback endpoint or deployment is touched.
