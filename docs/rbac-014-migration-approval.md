# RBAC-014 production migration approval proposal

Status: proposal for independent review; production approval and execution have not occurred.

RBAC-014 implementation PR #47 merged into `main` at `56e6cb873e700c5ab833a08f1d1395aaedecc204`. Main CI run [39718721741](https://github.com/Truevinecloud/TruevineVoice/actions/runs/39718721741) completed successfully on that exact SHA. This record and the matching migration-manifest entry propose permitting the release code to contain migration `20261022110000_rbac_014_support_access_sessions`; they do not apply the migration or authorize a production deployment.

## SQL review

SHA-256 of the repository migration file:

`FDB3248ED2494C3B045D3D30E8262B15829B2BF2D65068F4221F4ACC5BFAB707`

The migration creates `support_access_sessions`, a unique index for support token hashes, an actor/auth-session lookup index, a unique `(user_id, id)` key on `sessions`, three restrictive foreign keys, and database checks for the fixed reason allowlist and a maximum 15-minute expiry. It contains no `DROP`, `DELETE`, `UPDATE`, `TRUNCATE`, backfill, or existing-row rewrite. The support table is newly created and starts empty.

The added unique index on existing `sessions` is compatible by construction if the existing primary-key constraint on `sessions.id` remains valid: uniqueness of `id` implies uniqueness of `(user_id, id)`. The composite key is needed so the new foreign key proves that the recorded support actor owns the referenced authentication session. The disposable PostgreSQL migration rehearsal and the full migration-chain E2E passed in CI. No direct production data or schema inspection was available for this review; the operator must verify the deployed schema and current migration ledger before execution and stop if they differ from the expected baseline.

The index is built on the existing sessions table without `CONCURRENTLY`, so PostgreSQL takes a lock that blocks writes to that table while the index is built. Reads remain available under the normal PostgreSQL index-build lock mode. The actual table size, active write rate, lock queue, and duration on production are unknown. Immediately before deployment, inspect table size and active sessions/locks using the approved administrator procedure; stop if the expected short supervised lock window is not safe. The repository deployment process applies migrations before switching application processes, but a migration failure can still leave database state requiring operator inspection.

## Compatibility, data, and rollback

The migration is additive and does not transform customer, membership, authentication, or audit rows. New foreign keys use `ON DELETE RESTRICT`, preserving support-session references and auditability; this can prevent deletion of an organization, user, or auth session while a support-session row references it. Expired/revoked session retention and any future cleanup policy require separate review and must not delete audit history casually.

There is no safe automatic down migration: dropping the new table would destroy support-session evidence, and removing the composite sessions key while the new foreign key exists would be invalid. A code rollback can leave the additive table, constraints, and index in place. PostgreSQL commits DDL statements individually here because the migration file has no explicit transaction wrapper. If migration execution fails partway, stop and inspect the Prisma migration ledger and schema privately; do not blindly retry, resolve, reset, or edit this migration. Recovery requires an explicitly reviewed operator plan based on the actual partial state.

The repository runbook requires current recovery evidence and a supervised recovery plan. The recovery evidence documented for the October 21 archive predates later migrations and is not a current production-data or restore-forward proof for this release. This proposal does not claim that it satisfies today's backup/recovery prerequisite. Before deployment, a release operator must review current production migration status, confirm an adequately recent recoverable archive using existing resources, and document the recovery decision. Do not create new backup infrastructure as part of this task.

## Required release gates

- This is a manifest proposal for human review. The migration must remain absent from deployable approval until this PR receives the required independent review and is merged.
- The repository's deployment workflow requires a successful push CI run on the exact new `main` SHA, the exact manifest/migration match, the production environment approval, and an explicit dispatch with `authorize_production=true`.
- Before any dispatch, the operator must verify the live database's actual migration ledger, production recovery evidence, available disk, active locks, and expected migration baseline. No production database was queried or changed for this proposal.
- After any separately authorized deployment, verify the deployed SHA, Prisma migration status, API health, PostgreSQL and Redis connectivity, website health, and the restricted support-access allowlist. Do not activate calls, charging, or provider execution.
- PR #47's GitHub record showed no independent review approval. A security review of the RBAC-014 implementation is still required before marking the task complete or proceeding with release.

The original RBAC-004 worktree remains untouched. No production migration, data modification, merge, or deployment is performed by this approval proposal.
