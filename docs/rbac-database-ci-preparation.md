# Isolated RBAC database test preparation

The `Isolated RBAC database E2E` workflow uses GitHub-hosted runners and disposable PostgreSQL 18 / Redis 8 service containers. No secrets, deployment environment or production credentials are referenced. Each matrix job gets a fresh `rbac_e2e_test` database; Prisma migrations apply only there. Services are removed by GitHub when the job ends, including failures and cancellations.

The CI-only branch `ci/isolated-rbac-database-e2e` intentionally contains no pending application changes and runs workflow safety checks only. Its green result is NOT billing/reporting acceptance. Push a separately authorized test snapshot to `test/rbac-database-e2e` to run both complete `billing.e2e-spec.ts` and `campaigns.e2e-spec.ts` suites. Both files are required; missing tests fail. Pull requests from candidate branches also run the matrix. This workflow has no deploy trigger. Existing required CI jobs are unchanged.

Run `npm run test:rbac-ci:checks` for local syntax and safety checks. The snapshot must contain the actual billing module, Prisma schema/migration, reporting changes and tests, not only test files. The original uncommitted working copy must remain untouched. Full release CI and security rehearsal are still required; the existing security harness currently rejects the added billing migration until its explicit expected migration list is reviewed. Do not remove that check.

## Billing migration approval prerequisites

1. Review the exact `20261019160000_customer_billing_rbac_004/migration.sql`, including organization keys/FKs, BIGINT UGX checks, unique replay constraints and append-only triggers. Confirm Prisma schema correspondence.
2. Pass billing and reporting real-PostgreSQL E2E, full CI, security/migration rehearsals and role/tenant acceptance. Verify representative existing data remains unchanged and inconsistent data is rejected safely.
3. Establish expand/contract compatibility with active and rollback application versions; document partial-migration recovery. Code rollback does not undo SQL. Never edit applied migrations, reset production, or use production for tests.
4. Verify a current production backup and its isolated restore as below. Agree the supervised execution/recovery plan and responsible operator.
5. Obtain human SQL/compatibility/recovery review, then make a separate reviewed manifest change adding exactly the new migration while preserving all existing approvals. ADR 0011 controls execution: the protected executor applies approved migrations before activation. The manifest's older operator-only comment is stale; do not treat it as evidence of current behavior.
6. Keep payment collection and settlement disabled. Pending requests must never credit a wallet. Approval is not proof of payment integration or feature acceptance.

## Production backup verification requirements

Record the exact backup timestamp, source database/release, protected archive location, nonzero size, format and SHA-256; verify the checksum against its recorded expected value and ensure the archive catalog is readable. For encrypted backups, verify the manifest ciphertext checksum, decryption capability and secure recovery-key access. Never publish archives, database credentials or recovery keys as CI artifacts.

An authorized operator must use the existing recovery procedure to restore that actual backup into a uniquely named isolated temporary PostgreSQL container/volume, never over production. Capture successful restore exit status, schema/constraint/index/enum and row-count fingerprints, and the restored `_prisma_migrations` ledger with no failed/pending applied records. Compare against the recorded source fingerprint and actual current schema, not the historical three-table example in the runbook. Prove volume recreation preserves the fingerprint and verify cleanup removed only rehearsal resources.

Use the reviewed `infrastructure/scripts/db-verify.sh preflight`, `backup`, `verify-restore <archive>` and `verify-volume <archive>` procedures in the trusted Linux environment. Check current freshness against the agreed recovery point objective and confirm recovery access, usable previous release and operator ownership. Synthetic GitHub restore tests establish tooling behavior only; they do not verify a production archive. Off-server recovery copies, scheduling, retention and encrypted-key custody must be verified against the established backup policy. None of these production checks was performed by preparing this CI change.

The isolated service jobs allocate free host ports and use the assigned PostgreSQL/Redis ports from GitHub's service context. Fixed development ports can collide with other runner services. See [GitHub service port mapping](https://docs.github.com/en/actions/tutorials/use-containerized-services/use-docker-service-containers#mapping-docker-host-and-service-container-ports).
