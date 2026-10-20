# Runbooks

Operational procedures for Truevine Voice: what to do when something breaks.

| Runbook | Covers |
| --- | --- |
| [Production deployment](./production-deployment.md) | Releasing application code, verification, rollback |
| [Cloudflare R2 backup setup](./r2-backup-setup.md) | Existing encrypted backup configuration, R2 token scope, retention and activation prerequisites |
| [Production backup preflight and first run](./production-backup-runbook.md) | Approval points, safe one-time execution, isolated restore verification and retention |
| [Authorized SSH recovery from Windows](./authorized-ssh-recovery-windows.md) | Locate and test existing VPS identities without exposing private keys or weakening host verification |
| [PostgreSQL and Redis recovery](./postgres-redis-recovery.md) | Backup, verified restore, volume recreation, datastore isolation |
| [Deployment audit](./deployment-audit.md) | Recorded findings from the initial deployment audit |
| [RBAC-001 staging rehearsal](./rbac-001-staging-rehearsal.md) | Rehearsing the RBAC-001 migrations on a disposable database, and preflighting production |

## Expected future runbooks

| Runbook                 | Covers                                               |
| ----------------------- | ---------------------------------------------------- |
| Local environment reset | Recreating PostgreSQL and Redis from scratch         |
| Queue backlog           | Diagnosing and draining a BullMQ backlog             |
| Provider outage         | Degraded Voice delivery and replay strategy          |
| Ledger reconciliation   | Proving wallet balances against the immutable ledger |
| Incident response       | Severity, escalation and communication               |
