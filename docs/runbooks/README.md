# Runbooks

Operational procedures for Truevine Voice: what to do when something breaks.

**Status: intentionally empty.** There is no deployed system yet, so runbooks
would be fiction. They are written as part of the task that introduces the
system or the failure mode they cover.

## Expected future runbooks

| Runbook                 | Covers                                               |
| ----------------------- | ---------------------------------------------------- |
| Local environment reset | Recreating PostgreSQL and Redis from scratch         |
| Database restore        | Restoring from backup and verifying integrity        |
| Queue backlog           | Diagnosing and draining a BullMQ backlog             |
| Provider outage         | Degraded Voice delivery and replay strategy          |
| Ledger reconciliation   | Proving wallet balances against the immutable ledger |
| Incident response       | Severity, escalation and communication               |
