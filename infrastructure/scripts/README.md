# Operational scripts

Helper scripts used during operations and maintenance. Commands needed daily
(`npm run infra:*`, `npm run prisma:*`) live in the root `package.json` where they
are discoverable without reading this directory.

| Script                    | Purpose                                                           |
| ------------------------- | ----------------------------------------------------------------- |
| `deploy.sh`               | Serialised entry point for release and rollback                   |
| `bootstrap-platform-owner.mjs` | Operator-only first Platform Owner creation; explicit approval and private activation; never automatic |
| `db-verify.sh`            | PostgreSQL and Redis backup, restore and persistence verification |
| `db-verify.runtime.sh`    | Runtime safety tests for `db-verify.sh` (Linux only)              |
| `run-db-verify-tests.mjs` | Skips the runtime tests cleanly off Linux                         |
| `rbac-001-preflight.sql`  | Read-only production preflight for the RBAC-001 migrations        |
| `rbac-001-rehearsal.sh`   | Rehearses the RBAC-001 migrations on a disposable PostgreSQL      |
| `run-rbac-001-rehearsal.mjs` | Skips the RBAC-001 rehearsal cleanly off Linux                 |

`rbac-001-preflight.sql` only ever _reads_ production: it opens a read-only
transaction with a short statement timeout and ends in `ROLLBACK`.
`rbac-001-rehearsal.sh` never touches production at all; it starts its own
container, network and volume (each named from a fresh run id and labelled
`truevine.rbac.rehearsal.run`) and removes them on exit. See
[`docs/runbooks/rbac-001-staging-rehearsal.md`](../../docs/runbooks/rbac-001-staging-rehearsal.md).

`db-verify.sh` only ever _reads_ the production datastores; it restores into
temporary containers and volumes. It destroys nothing that does not carry this
run's `truevine.verify.run` label, and it fails closed when ownership cannot be
proven. See
[`docs/runbooks/postgres-redis-recovery.md`](../../docs/runbooks/postgres-redis-recovery.md).

Run the checks with `npm run test:deployment` (Vitest static assertions plus the
runtime suite) or `npm run test:db-verify` (runtime only). Run the RBAC-001
rehearsal with `npm run test:rehearsal` (Linux and a container runtime only).

## Expected future scripts

- Ledger reconciliation and audit report generation.
- One-off data backfills, each reviewed and idempotent.
- Queue replay tooling for a known-bad job batch.
