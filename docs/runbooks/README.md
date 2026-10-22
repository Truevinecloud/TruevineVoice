# Runbooks

Operational procedures for Truevine Voice: what to do when something breaks.

**OPEN operational obligation:** RBAC-014 audit-log collection and alert delivery
verification — owner **@benjatruevine**, due **23 October 2026, 12:00 EAT**.
See [deployment completion and follow-up acceptance](../rbac-014-deployment-status.md).

| Runbook | Covers |
| --- | --- |
| [Production deployment](./production-deployment.md) | Releasing application code, verification, rollback |
| [Support-access audit failure monitoring](./support-access-audit-alerting.md) | Event collection, alerting requirements and verification evidence |
| [First Platform Owner bootstrap](./platform-owner-bootstrap.md) | Approval, private activation, one-time claim and interrupted execution |
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
