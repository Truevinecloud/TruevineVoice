# ADR 0014: First Platform Owner bootstrap

Status: local implementation; production migration and execution approval withheld.
Date: 2026-10-20.

## Context

The initial design was reviewed from the isolated UAT readiness worktree's
`docs/platform-owner-bootstrap-proposal.md`. Customer OWNER creation is not
platform authority. Operations Admin provisioning requires an existing active
PLATFORM_OWNER. There is no legitimate first grantor inside the database and no
public registration or role-management endpoint.

## Decision

Use a Linux operator-only root npm command, never a controller, startup hook or
deployment action. It accepts only a dedicated new normalized identity. No
existing identity, role, membership, audit entry or credential is changed.
The password hash is derived from cryptographically random unusable material;
the intended recipient sets their own password using the existing single-use
24-hour password-reset/activation contract. Platform authority remains governed
by the existing permission registry and per-request guards.

Require an explicit environment matching NODE_ENV, process opt-in, stable
operation UUID and matching private approval JSON. Bind that approval to the
email, database host/port/name, HTTPS customer activation origin, environment,
operator reference, request reference and short validity window. Validate the
connected database name, reject URL redirection options, and require separate
production confirmation and productionAuthorized approval. The JSON is an
operator-recorded approval, not a cryptographic signature or a substitute for
external human authorization; the executing operator must verify that record
independently. No database PLATFORM_OWNER can self-authorize the first grant.

Production also binds the approved PostgreSQL system identifier and checks it
through pg_control_system() before writes. This read must already be permitted;
the command grants no privileges and fails closed when it is unavailable.
The fingerprint is not unique across physical clones, so trusted routing and
independently checked inventory remain essential.

One serializable transaction checks for any prior owner assignment or immutable
claim and existing email, then creates the user, PLATFORM_OWNER assignment,
activation hash, identity audit and singleton claim. Audit actorUserId points
to the newly created subject to satisfy the existing identity audit foreign
key. Metadata explicitly marks actorKind=external_operator and records the
approving/executing operator reference, approval reference and subjectUserId;
it does not imply the new identity approved itself. grantedByUserId remains
null because no existing user legitimately made the grant.

The platform-owned `platform_owner_bootstrap` table has a SQL-constrained fixed
primary-key slot, unique operation/user/audit IDs, restrictive foreign keys,
role/audit consistency checks and update/delete/truncate refusal. It is not
tenant-owned and fabricates no organization. A consumed claim stays consumed
even after activation expires or an owner is revoked. Refusing any prior owner
assignment is deliberately stricter than refusing active/pending owners only.
Revocation, lost access and owner replacement need a separate audited recovery
decision, not another bootstrap. The database key, not Redis or a process lock,
fences simultaneous commands with different emails and operation IDs.

## Credential delivery and ambiguous outcomes

Require existing absolute private directories outside the repository, Linux
ownership, directory mode 0700 and regular approval/activation files mode 0600.
Reject symlinks, unsafe ownership, hard-linked files and overwrite. The
activation file is exclusively created and fsynced (including its directory)
before database work; the raw link is never returned or logged. ORM error
logging is explicitly disabled for this credential-producing command. A new
optional database-factory log setting preserves existing callers' behavior.

Filesystem operations pin a directory descriptor via Linux /proc/self/fd.
Reject writable non-sticky ancestors, foreign-owned ancestors, malformed
operation IDs and replacement artifacts during cleanup. Root and processes
sharing the operator UID are trusted; same-UID hostile-process isolation is
outside this handoff contract.

There is no database/filesystem distributed transaction. Definite refusals and
unique/serialization rollbacks retire their uncommitted artifact. Unknown
transaction outcomes preserve it and fail with a fixed diagnostic. Do not
blindly retry, rotate a token or delete a possibly committed artifact. Reconcile
the stable operation and claim through authorized read-only inspection first.
The Linux file handoff is not enabled on Windows; local database E2E uses an
in-memory synthetic artifact seam, while testing the actual database and
authentication transactions. Production Linux filesystem/browser rehearsal
remains an execution prerequisite.

## Migration and validation

The additive new migrations use explicit BEGIN/COMMIT and change no existing
identity or role rows. The separate TRUNCATE guard preserves the first migration
after its disposable rehearsal. A third forward migration fixes the trigger's
search path to pg_catalog, public, pg_temp, preventing caller temporary tables
from satisfying its role/audit checks. No grants or SECURITY DEFINER are added.
None is added to migrations-reviewed.json, so ordinary
deployment correctly refuses this unapproved tree. Application rollback leaves
the immutable claim and audit intact. Do not drop them or roll back credentials
to repeat bootstrap. Approval needs SQL/backward-compatibility/lock review,
actual backup/restore recovery evidence and an approved forward-recovery plan.

The existing security rehearsal's exact migration sequence is extended with
this migration; no guard is relaxed. Unit tests cover environment/approval,
private-stat rules, redaction, refusal and ambiguous outcomes. Fresh PostgreSQL
tests cover successful creation, pre-existing/pending/revoked owner refusal,
concurrent attempts, final-claim/audit failure rollback and real activation
expiration/reuse. No production account or migration is created by validation.
