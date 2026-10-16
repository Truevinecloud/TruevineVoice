-- ---------------------------------------------------------------------------
-- Identity and authorization foundation for RBAC-001 (ADR 0009).
--
-- REVIEWED SQL. This file is the review artifact the deployment interlock
-- expects: adding it to the tree BLOCKS production deployment until a human
-- lists it in `infrastructure/migrations-reviewed.json`. It is deliberately not
-- listed there by the change that introduces it, because that manifest is the
-- human review point and approving one's own migration defeats it.
--
-- STATEMENT ORDER IS LOAD-BEARING
-- -------------------------------
-- 1. `citext` must exist before any CITEXT column is created.
-- 2. The `MembershipRole` enum swap must run AFTER `invitations` exists.
--    `prisma migrate diff` emits the swap before the tables, referencing a table
--    that does not exist yet. The generated script was reviewed and reordered
--    by hand; this comment records why, so nobody re-derives the broken order.
--
-- BACKWARD COMPATIBILITY
-- ---------------------
-- Fully backward compatible, and trivially so: every statement is additive.
--   - No column is dropped, renamed or retyped on populated data.
--   - The one destructive statement, replacing the `MembershipRole` enum, is
--     safe *only* because `memberships` is empty. Verified before authoring:
--       SELECT count(*) FROM memberships;  -- 0
--       SELECT count(*) FROM organizations; -- 0
--     Once real data exists this statement becomes a data migration. That is why
--     it was done now rather than later.
--   - `ALTER TABLE memberships ADD CONSTRAINT memberships_user_id_fkey` locks the
--     table for the duration. On an empty table this is instantaneous. On a
--     populated one it would need CONCURRENTLY and a two-step plan.
--   - The currently deployed application queries none of these tables, so it is
--     unaffected by their existence.
--
-- This is an EXPAND with no CONTRACT step.
--
-- ROLLBACK
-- --------
-- Safe only while the tables are empty, which they are:
--   DROP TABLE security_audit_events, invitations, platform_role_assignments,
--              terms_acceptances, password_reset_tokens, sessions, users;
--   ALTER TABLE memberships DROP CONSTRAINT memberships_user_id_fkey;
--   DROP TYPE "AuditOutcome", "AuditScope", "UserStatus", "PlatformRole";
-- Once product code writes identity data this stops being a rollback and
-- becomes a forward-only change.
--
-- EXECUTION PLAN (supervised operator action, AGENTS.md 12)
-- -------------------------------------------------------
-- 1. Back up production PostgreSQL and confirm the restore path works.
-- 2. Confirm the migration role may `CREATE EXTENSION citext`. If it may not,
--    ask a DBA to run that one statement first; nothing here needs superuser
--    beyond the extension.
-- 3. Confirm `memberships` and `organizations` are empty, so the enum swap is
--    safe. If they are not, STOP and do not run this migration.
-- 4. Apply with `prisma migrate deploy` from a controlled environment.
-- 5. Verify every object below exists and the migration ledger records it.
--
-- DEPLOYMENT IS BLOCKED BY THIS FILE UNTIL STEP 6 IS DONE BY A HUMAN.
-- ---------------------------------------------------------------------------

-- citext makes the unique index on users.email and invitations.email
-- case-insensitive, so `Alice@x.com` cannot become a second account for
-- `alice@x.com` even if a caller bypasses normalisation.
CREATE EXTENSION IF NOT EXISTS citext;

-- CreateEnum
CREATE TYPE "PlatformRole" AS ENUM ('PLATFORM_OWNER', 'OPERATIONS_ADMIN', 'BILLING_ADMIN', 'SUPPORT_ADMIN', 'TECHNICAL_ADMIN', 'AUDITOR');

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('ACTIVE', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "AuditScope" AS ENUM ('ORGANIZATION', 'PLATFORM');

-- CreateEnum
CREATE TYPE "AuditOutcome" AS ENUM ('SUCCESS', 'DENIED');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "email" CITEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE',
    "failed_login_count" INTEGER NOT NULL DEFAULT 0,
    "locked_until" TIMESTAMPTZ(3),
    "password_changed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token_hash" VARCHAR(64) NOT NULL,
    "previous_token_hash" VARCHAR(64),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "last_used_at" TIMESTAMPTZ(3),
    "revoked_at" TIMESTAMPTZ(3),
    "revoked_reason" VARCHAR(64),
    "user_agent_hash" VARCHAR(64),
    "ip_prefix" VARCHAR(64),

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "password_reset_tokens" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token_hash" VARCHAR(64) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "used_at" TIMESTAMPTZ(3),

    CONSTRAINT "password_reset_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "terms_acceptances" (
    "user_id" UUID NOT NULL,
    "terms_version" VARCHAR(32) NOT NULL,
    "accepted_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ip_prefix" VARCHAR(64),

    CONSTRAINT "terms_acceptances_pkey" PRIMARY KEY ("user_id","terms_version")
);

-- CreateTable
CREATE TABLE "platform_role_assignments" (
    "user_id" UUID NOT NULL,
    "role" "PlatformRole" NOT NULL,
    "granted_by_user_id" UUID,
    "granted_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMPTZ(3),

    CONSTRAINT "platform_role_assignments_pkey" PRIMARY KEY ("user_id")
);

-- CreateTable
CREATE TABLE "invitations" (
    "organization_id" UUID NOT NULL,
    "id" UUID NOT NULL,
    "email" CITEXT NOT NULL,
    "role" "MembershipRole" NOT NULL,
    "token_hash" VARCHAR(64) NOT NULL,
    "invited_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "accepted_at" TIMESTAMPTZ(3),
    "accepted_by_user_id" UUID,
    "revoked_at" TIMESTAMPTZ(3),

    CONSTRAINT "invitations_pkey" PRIMARY KEY ("organization_id","id")
);

-- CreateTable
CREATE TABLE "security_audit_events" (
    "organization_id" UUID NOT NULL,
    "id" UUID NOT NULL,
    "actor_user_id" UUID NOT NULL,
    "action" VARCHAR(64) NOT NULL,
    "scope" "AuditScope" NOT NULL,
    "outcome" "AuditOutcome" NOT NULL,
    "target_type" VARCHAR(64),
    "target_id" VARCHAR(64),
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "occurred_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "security_audit_events_pkey" PRIMARY KEY ("organization_id","id")
);

-- AlterEnum
-- Replaces OWNER|ADMIN|OPERATOR|VIEWER with OWNER|ADMIN|CAMPAIGN_MANAGER|BILLING|VIEWER.
-- Placed after the table definitions above because `invitations.role` references
-- this type and did not exist when `prisma migrate diff` emitted this block.
--
-- `OPERATOR` has no successor row to map: the table is empty, which is the only
-- reason a destructive enum change is acceptable here at all.
BEGIN;
CREATE TYPE "MembershipRole_new" AS ENUM ('OWNER', 'ADMIN', 'CAMPAIGN_MANAGER', 'BILLING', 'VIEWER');
ALTER TABLE "invitations" ALTER COLUMN "role" TYPE "MembershipRole_new" USING ("role"::text::"MembershipRole_new");
ALTER TABLE "memberships" ALTER COLUMN "role" TYPE "MembershipRole_new" USING ("role"::text::"MembershipRole_new");
ALTER TYPE "MembershipRole" RENAME TO "MembershipRole_old";
ALTER TYPE "MembershipRole_new" RENAME TO "MembershipRole";
DROP TYPE "public"."MembershipRole_old";
COMMIT;

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_token_hash_key" ON "sessions"("token_hash");

-- CreateIndex
CREATE INDEX "sessions_user_id_idx" ON "sessions"("user_id");

-- CreateIndex
CREATE INDEX "sessions_expires_at_idx" ON "sessions"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "password_reset_tokens_token_hash_key" ON "password_reset_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "password_reset_tokens_user_id_idx" ON "password_reset_tokens"("user_id");

-- CreateIndex
CREATE INDEX "platform_role_assignments_role_idx" ON "platform_role_assignments"("role");

-- CreateIndex
CREATE UNIQUE INDEX "invitations_token_hash_key" ON "invitations"("token_hash");

-- CreateIndex
CREATE INDEX "invitations_email_idx" ON "invitations"("email");

-- CreateIndex
CREATE INDEX "security_audit_events_actor_user_id_idx" ON "security_audit_events"("actor_user_id");

-- CreateIndex
CREATE INDEX "security_audit_events_action_idx" ON "security_audit_events"("action");

-- CreateIndex
CREATE INDEX "security_audit_events_occurred_at_idx" ON "security_audit_events"("occurred_at");

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "password_reset_tokens" ADD CONSTRAINT "password_reset_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "terms_acceptances" ADD CONSTRAINT "terms_acceptances_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform_role_assignments" ADD CONSTRAINT "platform_role_assignments_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform_role_assignments" ADD CONSTRAINT "platform_role_assignments_granted_by_user_id_fkey" FOREIGN KEY ("granted_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_invited_by_user_id_fkey" FOREIGN KEY ("invited_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_accepted_by_user_id_fkey" FOREIGN KEY ("accepted_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "security_audit_events" ADD CONSTRAINT "security_audit_events_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "security_audit_events" ADD CONSTRAINT "security_audit_events_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
-- The constraint ADR 0006 said should exist and did not: until now the database
-- accepted a membership for a user that did not exist.
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Append-only audit trail, enforced by the database.
--
-- A `REVOKE UPDATE, DELETE` would NOT be sufficient: the application connects as
-- the table's owner, and a table owner bypasses its own grants. A trigger is the
-- only mechanism that holds against a careless future query, a direct psql
-- session, or an ORM call nobody reviewed. Application discipline alone is what
-- this is replacing.
--
-- CONSEQUENCE, stated plainly: this trigger also fires for the ON DELETE CASCADE
-- from `organizations`. An organization therefore cannot be hard-deleted while
-- it has audit events. That is intended - deleting a tenant must not be able to
-- destroy the record of what happened in it - and it means organization removal
-- has to become a soft delete. There is no soft-delete column on `organizations`
-- yet, because nothing in RBAC-001 deletes an organization. Whoever implements
-- tenant removal must add it rather than reaching for a hard DELETE.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION security_audit_events_append_only() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION
        'security_audit_events is append-only: % is not permitted', TG_OP
        USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER security_audit_events_no_update_delete
    BEFORE UPDATE OR DELETE ON "security_audit_events"
    FOR EACH ROW EXECUTE FUNCTION security_audit_events_append_only();