# ADR 0023: campaign draft preparation is separate from execution

- **Status:** Proposed with W3-03; requires PR review before release.
- **Date:** 2026-10-25

## Context

Campaign Builder needs to save an audience, audio selection, schedule and retry
policy before an execution subsystem exists. Preparing a campaign must not make
calls, create recipient snapshots, enqueue jobs or activate paid providers.
Consent and suppression may also change between preparation and any future
dispatch.

## Decision

- Campaign preparation writes only a `DRAFT` campaign and tenant-scoped contact
  group references. Public builder mutations cannot change campaign lifecycle
  state; activation belongs to a separately authorized execution path.
- Schedules are timezone-bearing timestamps 5 minutes to 365 days in the future.
  They are saved configuration only; no scheduler is started by this feature.
- Retry attempts include the initial attempt and are bounded to 1–5. Retry delay
  is bounded to 5–1440 minutes.
- Preflight checks configuration and counts currently consented, unsuppressed
  contacts in selected groups. It returns no contact identifiers or phone
  numbers and creates no recipient or execution rows. Eligibility must be
  resolved again at dispatch.
- Group references use composite organization foreign keys. Future dispatch
  owns immutable recipient snapshots and durable idempotency under ADR 0018.

## Consequences

Preflight is an estimate, not a reservation or promise of deliverability. A
campaign can pass now and fail a future dispatch check if its audience or
consent/suppression state changes. Provider credentials and outbound execution
remain outside this decision.
