# 0011 — Apply reviewed migrations before release activation

Status: Accepted for implementation; production rollout requires verified access and CI.

The deployment approval manifest previously permitted code to ship without applying
its schema. RBAC-003 exposed this gap. This supersedes the operator-only execution
policy in ADR 0005; the existing protected workflow and deployment gates remain.

After a successful build and exact manifest validation, the locked deployment
executor runs the existing `prisma:migrate:deploy` command in the prepared release.
It reads DATABASE_URL from the shared production `.env`, overriding ambient values.
Prisma output is captured because it can contain connection details. Errors expose
only a fixed diagnostic and fail deployment before any PM2 or current-link change.

Review must establish compatibility with the currently active code, SQL scope,
a rehearsed backup and recovery procedure. Prisma failure may leave partial schema
changes. Operators must inspect migration state securely before retrying; there is
no automatic database rollback or reset. Activation failure still restores previous
code, so migrations must follow expand/contract. Explicit code rollback skips SQL.

The workflow fix does not approve RBAC-003. Approval is a separate reviewed change.
Production access and corrected workflow verification are prerequisites to rollout.
