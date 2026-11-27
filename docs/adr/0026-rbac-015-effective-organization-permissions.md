# ADR 0026 — RBAC-015 effective organization permissions

Status: Approved Phase 2 policy. Live PostgreSQL verification and deployment remain pending.

Organization permissions come from the existing built-in membership role plus fresh custom grants for the same active member in the same nonsuspended path tenant. The only custom-delegable identifiers are `organization:read`, `campaign:read`, `campaign:create`, `campaign:delete`, `audio:read`, `contact:read`, `contact:create`, and `reporting:read`. The other 15 organization permissions remain built-in-only. All 15 platform permissions remain outside this policy.

Grantors need the permission through their current built-in role. Received custom grants cannot be re-delegated. Assignment retains the strictly downward check. Protected entries in existing roles do not authorize operations. New definitions and permission replacements reject protected grants, and the built-in authority rules govern access to clean up old entries. The underlying role names, built-in mappings, composite tenant keys and schema remain the same.

The organization guard and transaction rechecks share the effective-permission evaluator. A sufficient built-in grant needs no custom lookup. Missing, invalid or unavailable custom authority cannot authorize access. Mutations that need custom authority load it after the existing organization row lock in a READ COMMITTED transaction. The shared SQL reader denies custom grants at another isolation level. Membership removal, role edits and revocation must use the same organization lock. Reads begun before a revocation may complete as described in ADR 0019.

`/me` keeps the built-in role field and returns fresh permissions per tenant. Suspended organizations have empty permission arrays. If a required lookup fails, `/me` returns a sanitized 503 and does not return a partial projection. Existing guards and write paths retain their terms, CSRF, ownership, membership and audit checks. Mandatory success audit failures still roll back the operation as described in ADR 0020.

Verification requires isolated PostgreSQL evidence for both lock orderings, grant lookup failure, same-tenant and foreign-tenant behavior, and audit rollback. Use a separately authorized target with the exact approved source, Prisma client, and migration fingerprint. Preserve existing QA data and the pinned launcher.
