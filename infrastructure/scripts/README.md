# Operational scripts

Reserved for helper scripts used during operations and maintenance.

**Status: intentionally empty.** The handful of commands needed today
(`npm run infra:*`, `npm run prisma:*`) live in the root `package.json` where
they are discoverable without reading this directory.

## Expected future scripts

- Database backup and verified restore.
- Ledger reconciliation and audit report generation.
- One-off data backfills, each reviewed and idempotent.
- Queue replay tooling for a known-bad job batch.
