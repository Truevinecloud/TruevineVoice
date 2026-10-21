# ADR 0020: Transactional sensitive-action audits in existing trails

- Task: RBAC-013
- Status: Proposed for review; production migration approval withheld
- Date: 2026-10-21
- Extends ADRs 0009, 0010 and 0019

Keep the existing tenant and identity audit tables, action names and consumer
envelopes. Add a versioned metadata contract for target, before/change/after,
reason and server correlation; project minimal state and retain old history.

Commit supported sensitive mutations and their required audit INSERT in one
PostgreSQL transaction. Recheck tenant/platform authority under existing locks.
Write unsuccessful-attempt evidence after rollback without reading foreign state;
a failure to record a denial cannot mask its original refusal.

Preserve old clients with explicit server reason codes when reason is omitted.
Validate supplied reason objects and retain mandatory emergency reason codes.
Generate request IDs on the server with concurrent async-context isolation.

Add statement-level TRUNCATE guards to both trails without editing applied SQL.
Retain row UPDATE/DELETE guards and history through application updates.
Owners/superusers can defeat DDL controls; no absolute immutability claim,
external audit service, automatic retention purge or new operational financial/
plan/provider functionality is introduced.

See [assessment, coverage matrix and SQL review](../rbac-013-sensitive-action-audit.md)
for attribution/retention limits, deferred integration, compatibility and
separate production migration approval.
