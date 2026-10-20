# RBAC-004 + RBAC-007 integration review

This integration snapshot combines PR #27 (`test/rbac-database-e2e`) and PR #28
(`feat/rbac-007-operations-admin`) without changing either source branch. It is
not merged to `main`, and no production migration approval or deployment has
occurred.

## Migration review

The RBAC-004 migration is additive and ordered before RBAC-007. Its tables,
indexes, constraints, function, and triggers can run inside one PostgreSQL
transaction. The integration copy adds an explicit outer `BEGIN`/`COMMIT` so a
late failure cannot leave partial billing DDL. Top-up creator scope is enforced
with a composite foreign key to `(memberships.organization_id, user_id)`; this
prevents a valid user from creating a request in another organization. A
PostgreSQL regression assertion covers that boundary.

RBAC-007 adds an independent campaign marker and triggers. It does not alter the
billing tables or role schema. Both migration failure/retry rehearsals run only
against fixed-name databases inside disposable GitHub Actions PostgreSQL. The
RBAC-004 rehearsal forces an error before `COMMIT`, confirms all DDL rolls
back, retries the exact SQL, and verifies the foreign key and immutable triggers.

## Operations Admin UAT provisioning

The staging-only command creates a new account with an unusable random
password, an `OPERATIONS_ADMIN` assignment, and a single-use password activation
token. Account, role assignment, token hash, and actor-attributed
`platform.operations_admin.provisioned` audit event commit together. It refuses
existing users, requires an active `PLATFORM_OWNER` and an approval reference,
rejects production/local database targets, and writes the activation link to a
private file outside the repository. CI rehearses allow, deny, audit, activation
privacy, and duplicate-request behavior on a disposable database.

The staging environment still needs a separately authorized active
`PLATFORM_OWNER`; no platform-role bootstrap command currently exists. Do not
use direct SQL to create that actor.

## Verification boundary

Local lint, typecheck, Prisma validation, unit tests and production build have
passed. Windows has no Docker CLI, so the combined PostgreSQL E2E, both migration
rehearsals, provisioning rehearsal, and PostgreSQL restore workflow require a
GitHub Actions run against this exact integration tree. PR #27 and PR #28 had
green individual CI runs, which do not substitute for combined CI. The
production migration approval manifest remains unchanged; payment collection,
wallet settlement, voice, SMS, and customer notifications remain disabled.
