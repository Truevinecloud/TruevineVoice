# ADR 0018: Recipient snapshots, call acceptance and durable idempotency

- Status: Accepted for development; production migration/deployment NOT authorized
- Date: 2026-10-21
- Canonical workplan task ID: UNVERIFIED
- Builds on ADRs 0003, 0006, 0009, 0010 and 0017

## Decision

Contacts contain a tenant-scoped E.164 destination and optional short label.
Campaign recipients capture an immutable destination from the scoped contact.
Contact edits never change recipients or accepted attempts. Composite foreign
keys include organization and campaign identifiers; deletes of referenced
contacts/campaigns are restricted. No customer endpoint or permission is added.

The business execution identity is the campaign, with exactly one
CampaignExecution per (organization, campaign) in this MVP. Within that execution,
(organization, execution, recipient, attemptNumber) identifies a deliberate
attempt. The initial attempt is number 1. A redial must name the latest terminal
attempt and supply a nonempty reason; it increments the attempt number. A
predecessor can have only one successor. A transport/request retry uses the
original idempotency key and original parameters, and never creates a redial.
Rerunning an entire campaign is not implemented; it needs an explicit future
business decision rather than generating a new execution ID or key.

Call acceptance is one PostgreSQL transaction: serialize the organization,
operation and validated key, look up replay, validate scoped parents, lock the
campaign/execution, validate predecessor, create attempt and immutable operation
result. The operation namespace is call.accept; it means durable acceptance,
not provider initiation or successful execution. PostgreSQL composite uniqueness
is authoritative; an advisory-lock hash collision merely serializes extra work.
The accepted attempt and result commit together or neither exists.

Fingerprint version 1 is SHA-256 over an explicitly ordered JSON tuple:
[1, "call.accept", organizationId, campaignId, recipientId,
previousAttemptId-or-null, trimmed-redialReason-or-null]. UUIDs are lowercase.
Keys are trimmed and bounded by the existing domain validator. Destination is
resolved from an immutable recipient, not from a mutable contact. A matching
key/fingerprint replays the stored original QUEUED acceptance result even after
the attempt advances. Different parameters or unsupported fingerprint versions
produce idempotency_conflict. Records have no expiry or automatic pruning.
The operation column isolates namespaces; additional paid operations must define
their own contracts rather than reuse call.accept.

Event processing locks the attempt, validates state/evidence, records each
delivery and advances state atomically. Events are append-only, including
duplicates, illegal transitions and conflicts. An event-key reused with changed
content is a conflict. A different late state cannot rewrite a terminal state;
changed terminal usage evidence is also a conflict. The persistence boundary
returns a diagnostic containing code, organization ID and attempt ID only.
Conflicts are durably queryable using the organization/disposition index.
Untrusted raw payloads, destinations and event keys are absent from diagnostics.
No webhook is exposed; future adapters must validate signatures and map payloads
before using this boundary.

Provider usage is evidence in call events only. There is no billable usage
writer, tariff table, wallet mutation, provider dispatch, queue consumer or
network call. ADR 0017's ceiling rule is PROVISIONAL until Africa's Talking
tariffs, connected-duration precision and charging increments are verified.
Current domain input accepts whole seconds, so ceiling cannot establish real
provider charging behavior.

## Database controls and rollout

The migration is additive and transactional: six new tables, a call-state enum,
tenant-leading keys/indexes, composite parent references, E.164/redial checks,
snapshot/attempt validation and immutable history triggers (including TRUNCATE).
State transitions are guarded in SQL as well as application code.
Custom checks/triggers must be retained when Prisma generates later migrations.
Existing tables receive no data changes. No new migration is added to the
production reviewed-migration allowlist.

SQL review: no DROP, data UPDATE, data DELETE, backfill or existing-column
rewrite. Foreign keys briefly lock referenced parents; operator review of lock
behavior and production migration timing remains required. Rollback is code
rollback with new tables retained, followed by a reviewed forward correction if
needed; dropping call history is not an approved rollback.

The repository uses narrow structural SQL/transaction interfaces. The caller
owns the connection lifecycle. It is intentionally unregistered in AppModule:
only trusted internal callers may supply an already authorized tenant.
Unit tests run without infrastructure; real PostgreSQL tests cover concurrent
acceptance, conflicting keys, redial forks, rollback, replay on a new connection,
tenant references, immutable evidence and event conflicts. Existing CI applies
the migration only to its disposable loopback PostgreSQL.

## Remaining gates

Durable acceptance is not exactly-once external execution. Provider-side keys,
ambiguous timeout reconciliation, callback signature verification, dispatch
recovery after Redis loss, emergency-stop rechecks at dispatch, charging policy,
authorization for future endpoints, retention/erasure policy and actual deployment
remain separate tasks. No customer data, infrastructure or backup change is made.
