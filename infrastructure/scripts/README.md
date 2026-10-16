# Operational scripts

Helper scripts used during operations and maintenance. Commands needed daily
(`npm run infra:*`, `npm run prisma:*`) live in the root `package.json` where they
are discoverable without reading this directory.

| Script | Purpose |
| --- | --- |
| `deploy.sh` | Serialised entry point for release and rollback |
| `db-verify.sh` | PostgreSQL and Redis backup, restore and persistence verification |
| `db-verify.runtime.sh` | Runtime safety tests for `db-verify.sh` (Linux only) |
| `run-db-verify-tests.mjs` | Skips the runtime tests cleanly off Linux |

`db-verify.sh` only ever *reads* the production datastores; it restores into
temporary containers and volumes. It destroys nothing that does not carry this
run's `truevine.verify.run` label, and it fails closed when ownership cannot be
proven. See
[`docs/runbooks/postgres-redis-recovery.md`](../../docs/runbooks/postgres-redis-recovery.md).

Run the checks with `npm run test:deployment` (Vitest static assertions plus the
runtime suite) or `npm run test:db-verify` (runtime only).

## Expected future scripts

- Ledger reconciliation and audit report generation.
- One-off data backfills, each reviewed and idempotent.
- Queue replay tooling for a known-bad job batch.
