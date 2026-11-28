# 0011 — Apply reviewed migrations before release activation

Status: Accepted for implementation; production rollout requires verified access, CI and owner approvals.

The deployment approval manifest previously permitted code to ship without applying
its schema. RBAC-003 exposed this gap. This supersedes the operator-only execution
policy in ADR 0005; the existing protected workflow and deployment gates remain.

`infrastructure/migrations-reviewed.json` is a **review allow-list only**. It gates
which migration directories may exist in a deployable tree; it does not apply SQL
and does not authorize production migration execution. An entry records that a
human reviewed the generated SQL, backward compatibility with the currently
deployed application, tenant and financial constraints, append-only behaviour,
locking, failure limits, and a rehearsed backup and recovery procedure. The
manifest and migration directories must match exactly in both directions.

Ordinary pull-request and `main` CI jobs use disposable databases only. They never
read production configuration and never apply production migrations. Production
migrations execute **only** inside the protected `deploy.yml` workflow, after all
of these gates pass: exact full SHA and successful main-push CI for that SHA,
manual `workflow_dispatch` with `authorize_production=true`, protected
environment review, this allow-list, explicit migration approval for the exact
release, and verified backup and recovery evidence.

After a successful isolated build and exact manifest validation, the locked
deployment executor runs the existing `prisma:migrate:deploy` command in the
prepared release within that workflow. It reads `DATABASE_URL` from the shared
production `.env`, overriding ambient values. Prisma output is captured because
it can contain connection details. Errors expose only a fixed diagnostic and
fail deployment before any PM2 or `current`-link change. A migration failure
prevents activation; it is not a reason to retry with a manual command.

Review must establish compatibility with the currently active code, SQL scope,
idempotency, data preservation, append-only ledger behaviour, lock impact, and a
rehearsed backup and recovery procedure. Prisma failure may leave partial schema
changes. Operators must inspect migration state securely before any further
action; there is no automatic database rollback or reset. Activation failure
still restores previous code, so migrations must follow expand/contract.
Explicit code rollback skips SQL and does **not** reverse applied migrations.
Restoring a database from backup is a separate, destructive operation that
requires its own explicit approval and is never performed over live production
as part of this workflow or the preflight rehearsal.

The workflow fix does not approve RBAC-003 or any RC1 migration. Approval is a
separate reviewed change. Production access and corrected workflow verification
are prerequisites to rollout.
