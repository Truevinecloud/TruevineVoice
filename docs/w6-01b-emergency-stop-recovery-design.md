# W6-01B emergency-stop recovery — design proposal only

**Date:** 2026-11-24
**Status:** Design proposal only. No recovery policy is approved. No implementation, migration, deployment, production data change or browser acceptance is authorized or claimed by this file.

This document records the current emergency-stop boundary and frames future decisions about recovery. It does **not** select a recovery design. “W6-01B” is used here only as the label for the proposed browser acceptance pass described in §7; it is not a release, deployment or product approval.

## 1. Source of truth

- [ADR 0013 — Platform Operations Admin emergency stops](adr/0013-platform-operations-admin.md) is accepted for implementation, with production deployment approval withheld. It makes the stop terminal, keeps the marker immutable at the database level, adds no resume or marker-clearing endpoint, and requires a separately reviewed recovery procedure.
- [ADR 0032 — W6-01 campaign dispatch reliability and emergency-stop amendment](adr/0032-w6-01-campaign-dispatch-reliability.md) is a draft amendment. It adds the authoritative dispatch boundary but explicitly leaves platform re-enable unimplemented and unapproved.
- [W6-01 verification evidence](w6-01-campaign-dispatch-reliability-verification.md) records isolated worker/API results and states that paired-Chrome browser acceptance was not performed.
- The relevant implementation is `apps/api/src/operations/`, `apps/api/src/campaigns/prisma-campaign.store.ts`, `apps/worker/src/reliability/dispatch-guard.service.ts`, the W6-01 migrations under `packages/database/prisma/migrations/`, and the customer campaign detail UI.

## 2. Current behaviour and invariants

### 2.1 Platform emergency stop

- The only platform stop route is `POST /platform/operations/organizations/:organizationId/campaigns/:campaignId/emergency-stop`. `OperationsController` applies `SessionGuard`, `PlatformGuard`, `CsrfGuard` and the explicit `platform:operations:write` permission. The controller contains no business query; it delegates to `OperationsService`, which validates the reason code and delegates the mutation and audit to `OperationsStore`.
- Today, `PLATFORM_OWNER` and `OPERATIONS_ADMIN` hold `platform:operations:write`. `AUDITOR`, `SUPPORT_ADMIN`, `TECHNICAL_ADMIN`, `BILLING_ADMIN` and organization roles do not. The current permission registry is in `packages/auth/src/permissions.ts`.
- `PrismaOperationsStore.emergencyStop()` runs one transaction. It authorizes the platform actor, takes the same campaign advisory lock the worker holds across provider invocation, locks the organization row, and updates only a campaign whose stored status is `ACTIVE` and whose `emergencyStoppedAt` is null. It sets legacy `status = COMPLETED`, `emergencyStoppedAt`, `dispatchState = CANCELLED`, `cancelledAt`, `dispatchStopReason = emergency_stop` and increments `dispatchEpoch`.
- The same transaction writes `platform.campaign.emergency_stopped` to the target organization’s append-only security audit table with `scope = PLATFORM`. Metadata is allowlisted; free-form operator text is not copied into the audit. A repeat stop resolves to `already_stopped` rather than a second mutation.
- The API response presents `dispatchState: 'CANCELLED'`, `dispatchStopReason: 'emergency_stop'`, `stopResult` and `voiceDispatchStopped: true`. The stored legacy status remains `COMPLETED`; presentation derives pause/cancel meaning from the dispatch fields.

### 2.2 Customer controls

- Customer pause, resume and cancel are organization-scoped operations requiring `campaign:pause`, `campaign:resume` and `campaign:cancel` respectively. The organization id comes from the authenticated path, never a trusted body field.
- `PrismaCampaignStore.transitionDispatchState()` takes the same advisory lock, rechecks membership/permission in the transaction, refuses any row with a marker or `CANCELLED` dispatch state, and permits resume only from `PAUSED` to `RUNNING` for a non-stopped `ACTIVE` campaign. Every accepted transition increments the epoch and writes an append-only sensitive-action audit.
- A customer resume on an emergency-stopped campaign is rejected. The isolated W6-01 HTTP evidence records HTTP `409` with `error.code = campaign_cancelled` and no dispatch-state change.
- The customer UI (`apps/web/src/app/app/campaigns/campaign-detail.tsx`) does not offer **Resume calls** or **Cancel campaign** when `emergencyStoppedAt` is set. Hiding the control is presentation only; the API guard and database constraints remain the authority.

### 2.3 Database and worker invariants

- `packages/database/prisma/migrations/20261020110000_rbac_007_emergency_stop/migration.sql` makes `emergency_stopped_at` immutable, refuses restart of an emergency-stopped campaign through the legacy `status` column, and refuses deletion of a stopped campaign.
- The W6-01 proposal migration `packages/database/prisma/migrations/20261124130000_w601_campaign_reliability/migration.sql` adds the dispatch columns and check constraints. It forbids a decreasing epoch, forbids leaving `CANCELLED`, forbids `dispatch_state = RUNNING` while a marker is set, and sets dispatch cancellation in the same statement that first sets the marker. It is absent from `infrastructure/migrations-reviewed.json` and has no production approval.
- `DispatchGuard.authorize()` re-reads PostgreSQL immediately before a paid provider invocation under the campaign and wallet advisory locks. It blocks on an emergency marker, pause/cancel dispatch state, non-`ACTIVE` status, suspended organization, absent/invalid cost policy or insufficient available balance. Redis, BullMQ payloads, in-memory flags and earlier worker decisions are never authoritative at this boundary.
- A dispatch reservation is a durable coordination row in `campaign_dispatch_reservations`, not a wallet entry and not a financial event. No tariff, reserve amount or production cost policy is approved in this repository; the isolated tests use a synthetic fixed reserve and production fails closed.
- A stop prevents **new** paid provider work from crossing the guard after the stop commits. It does not cancel a provider-accepted call, reverse a charge, delete call history or resolve an `UNKNOWN` reconciliation record.

## 3. Why recovery is deliberately deferred

1. ADR 0013 accepted emergency stop as terminal and deliberately omitted restart because voice dispatch did not exist at that time. It requires a separately reviewed recovery procedure.
2. ADR 0032 proposes properties for a future re-enable — a distinct platform permission, a second platform actor, a durable incident/override record, a new authorized state rather than marker clearing, and a separately reviewed migration — but accepts none of them. There is no approved authority model.
3. The existing database triggers and constraints intentionally make the stop hard to reverse. Removing or widening them is a backward-compatibility and audit-integrity decision, not a local code edit.
4. The W6-01 migration is still a proposal and is not in the reviewed-migrations manifest. A recovery migration would be an additional cross-cutting schema decision, not an amendment made inside this documentation task.
5. Reactivation would cross the same paid-provider boundary that the emergency stop exists to protect. Without an approved cost policy, authority policy and incident record, implementing recovery would create an unaudited way to resume spending.
6. The requested W6-01B browser acceptance is a negative-control check: it must prove the stop survives worker replacement, customer recovery is refused and unauthorized platform users are denied. It is not evidence that recovery is safe or desired.
7. Product specification sections §11 and §31 are unavailable in this workspace. No recovery entitlement, billing rule, tariff or provider policy is inferred from them.

## 4. Explicit non-goals

This proposal does **not** authorize or perform any of the following:

- clearing `emergency_stopped_at`, moving a stopped campaign back to `ACTIVE`, or making `dispatch_state = RUNNING` while a marker exists;
- adding a re-enable, unstop, undo-stop, recovery or override button/API/script/command;
- changing the customer pause/resume/cancel semantics for an emergency-stopped campaign;
- editing, dropping or replacing the RBAC-007 or W6-01 migrations, changing database triggers/constraints, or adding the W6-01 migration to `infrastructure/migrations-reviewed.json`;
- granting new platform permissions or roles, provisioning accounts, or changing the current permission registry;
- editing production data with ad-hoc SQL or applying a migration to any database holding data this task did not create;
- deploying code, activating a release or declaring production readiness;
- inventing or selecting a tariff, reserve policy, payment behavior, refund rule, provider policy or wallet correction;
- cancelling an already-accepted provider call, replaying an initiated call, reversing a ledger entry or deleting call/audit history;
- running or claiming the W6-01B browser acceptance pass;
- choosing between the candidate options in §5.

## 5. Candidate options — conceptual only, no selection

These are alternatives to be evaluated only after owner decisions in §6. Listing them is not a recommendation or an implementation plan.

### Option A — New campaign generation

Treat the stopped campaign as immutable history. A separate, explicitly authorized preparation flow creates a **new** campaign with a new `(organizationId, id)` identity and explicitly chosen, revalidated preparation inputs. The original marker, audit trail, call history and settlement evidence are never altered. This avoids reversing a terminal record, but it requires decisions about lineage in audit metadata, audience/consent revalidation, duplicate-contact handling and how the new campaign relates to the stop incident. It must not silently replay already-initiated attempts.

### Option B — Audited in-place unstop with explicit authority

Keep the campaign identity and introduce a reviewed transition to a new authorized dispatch state — explicitly **not** `RUNNING` while `emergency_stopped_at` remains set, as proposed in ADR 0032 §6. Authority would be bound to a named platform role with a new permission distinct from `platform:operations:write`, a second platform actor, and a durable incident/override record referencing the original `platform.campaign.emergency_stopped` audit event. This requires a separately reviewed migration that preserves rollback compatibility and the append-only audit trail. The exact state vocabulary, lock ordering, in-flight behavior and API surface remain undecided.

### Option C — No in-product recovery; reviewed manual procedure only

Preserve the ADR 0013 status quo. Any exceptional reactivation is handled by a separately reviewed, audited operator procedure outside this application change. This keeps the product surface minimal but still requires an owner-approved procedure before anyone acts; it is not permission to clear the marker or edit production data ad hoc.

No option is selected by this document. Any approval must be recorded in a separate design decision/ADR before code is written.

## 6. Owner decisions required before any implementation

The owner must decide and record, at minimum:

1. **Policy existence:** whether emergency-stop recovery is a required capability at all, or remains out of product scope.
2. **Option and semantics:** which candidate model applies; what the authoritative state means; whether the original campaign identity is reused; what the UI/API truthfully calls the resumed state.
3. **Authority:** which named platform role and new permission may initiate recovery; whether two distinct actors are mandatory; whether the initiating and authorizing actors must be different; whether any organization-side approval is required; what happens on missing, expired or mismatched authorization.
4. **Incident record:** what evidence must exist before recovery (incident id, original stop audit reference, reason codes, justification handling, retention and redaction), while respecting the existing rule that audit metadata is allowlisted and free-form text is not copied indefinitely.
5. **Immutability boundary:** whether the marker remains immutable forever; how database check constraints and triggers are changed backward-compatibly; how an application rollback behaves before and after migration.
6. **Financial boundary:** whether any approved cost policy, reserve or payment rule is needed. If none is approved, dispatching must continue to fail closed; this design does not supply one.
7. **Dispatch boundary:** how the recovery transition interacts with the advisory lock, dispatch epoch, queued/delayed/retried jobs, in-flight calls, `UNKNOWN` reconciliation and held reservations. No queue or Redis state may become authoritative.
8. **Idempotency and concurrency:** how duplicate requests, two simultaneous approvers and repeated approval records are rejected or made safe to retry.
9. **Tenant and audit scope:** that organization identity remains path/session-derived, all tenant-owned rows remain organization-scoped, and all transitions write append-only audits with tenant foreign keys intact.
10. **Release gates:** migration review and manifest entry, disposable-database rehearsal, CI, explicit operator approval and a separate deployment decision. ADR 0013/0032 production approval remains withheld until those gates are met.

## 7. Required tests and evidence if approved

If — and only if — a recovery design is separately approved, implementation must include behaviour tests matching existing Vitest/E2E style. Unit tests must use injected fakes and require no PostgreSQL or Redis. E2E/browser tests must use isolated infrastructure and fail loudly when it is absent. No failing test may be skipped or weakened.

### 7.1 Contract and unit evidence

- State machine: no epoch decrease; no `CANCELLED` restart; no `RUNNING` with a marker; recovery permitted only through the approved state and authority path; stale-epoch jobs refused.
- `DispatchGuard`: zero paid provider invocations for stopped, paused, cancelled, stale-epoch and unauthorized-recovered campaigns; policy absence still fails closed.
- Service/controller: invalid reason codes and unauthorized roles rejected; platform actions delegate to the service; no business query in a controller; explicit `@Inject(...)` for every constructor dependency.

### 7.2 Isolated HTTP/database evidence

- Emergency stop remains atomic with its audit; repeat stop is `already_stopped`; tenant/path mismatches and foreign campaign ids are denied.
- Customer resume on an emergency-stopped campaign returns HTTP `409` with `campaign_cancelled` and produces no accepted transition audit.
- Unauthorized platform roles receive `403` for platform stop and any approved recovery route; organization members cannot invoke platform recovery even with all customer campaign permissions.
- Any approved migration is rehearsed forward and with application rollback on a disposable database, including negative trigger/constraint cases. It is added to `infrastructure/migrations-reviewed.json` only after review, never before.

### 7.3 W6-01B browser acceptance requirements

The browser pass must be executed on dedicated isolated web/API/admin services, the isolated W6-01 PostgreSQL database and Redis namespace, with synthetic accounts and a fake voice adapter. No live provider, payment provider, callback URL, production database, default stack or W5-03E stack may be touched. The pass must verify and record:

1. **Persistence across an isolated worker restart:** stop a synthetic campaign through the admin UI; capture `dispatchState = CANCELLED`, `dispatchStopReason = emergency_stop`, the marker timestamp, epoch, audit event and fake-provider invocation count; stop the isolated worker process; start a replacement worker against the same isolated database and queue configuration; re-read the admin and customer views plus PostgreSQL. The stopped state, reason, marker and audit must be unchanged, and no new paid invocation may occur.
2. **Customer resume rejected:** after the restart, the customer campaign detail must not offer Resume for the stopped campaign; a direct browser request to `POST /organizations/:organizationId/campaigns/:campaignId/resume` must be rejected (`409 campaign_cancelled` under the current contract) with no dispatch mutation or new audit success.
3. **Unauthorized platform users denied:** synthetic platform users without `platform:operations:write` (and without any future recovery permission) must be denied the platform stop route and any approved recovery route; no recovery control is available to them. Authorized vs unauthorized results must be captured as real HTTP responses, not simulated UI text.
4. **No recovery surface:** no button, route, script result or visible admin workflow clears the marker or presents an emergency-stopped campaign as resumable.
5. **Evidence:** screenshots, network request/response captures, database assertions, audit rows, worker-process start/stop records and fake-provider invocation counts, with no credentials or connection strings in the artifacts.

A browser pass that only checks rendered text is insufficient; it must include the real requests and durable-state checks above.

### 7.4 Quality gates

`lint`, `typecheck`, `test`, `build` and the relevant isolated E2E scripts must run and be reported honestly. Any pre-existing red gate must be reported, not hidden by a rule change, suppression or skipped test.

## 8. Production-readiness statement

**W6-01B browser acceptance, if performed, verifies only the isolated negative controls in §7.3. It does not imply production readiness, migration approval, recovery-policy approval, cost-policy approval or deployment authorization.** Emergency-stopped campaigns remain terminal. No marker clearing, re-enable flow, new button, production migration or deployment is authorized by this document. Any future reactivation requires separate design approval.

## 9. Observed documentation conflicts — not resolved here

- The README’s older “Platform-admin app provides an Operations console” section says emergency stop “pauses and locks an active campaign record; no voice provider or call dispatch is connected” and describes health as `not_integrated`. The newer W6-01 section and ADR 0032 describe a re-read PostgreSQL guard, `voiceDispatchStopped: true` and fake-provider invocation counters in isolated tests. ADR 0032 explicitly presents itself as an amendment to the earlier position, but the README has not been reconciled. This document reports the inconsistency and does not edit either source.
- ADR 0013 says emergency stop applies to the campaign record only until voice dispatch is implemented; ADR 0032 adds dispatch semantics while retaining terminality. Read together, the newer ADR narrows the older statement. Production deployment approval remains withheld in both.
