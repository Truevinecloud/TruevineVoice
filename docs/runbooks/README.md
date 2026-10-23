# Runbooks

Operational procedures for Truevine Voice: what to do when something breaks.

| Runbook | Covers |
| --- | --- |
| [Production test-account executable workflow](./production-test-account-execution.md) | Implemented operator commands; private approval, bootstrap, HTTP verification and disable; production execution not authorized |
| [Production test-account rollout — review draft](./production-test-account-rollout.md) | Proposed inventory, independent approvals, bootstrap, private password initialization, deployment and retirement; no execution authorized |
| [Production HTTP acceptance — not run](./production-test-account-http-checklist.md) | Eleven-account actual sign-in, role and tenant checks, safe evidence and missing feature limits |
| [QA Owner recovery](./qa-owner-recovery.md) | Operator-only replacement activation link for the existing QA Owner |
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
