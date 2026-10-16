-- ---------------------------------------------------------------------------
-- Identity half of the security audit trail (RBAC-001).
--
-- Added as a SECOND migration rather than by editing
-- `20261016130500_identity_rbac_001`, because that migration had already been
-- applied to a database. AGENTS.md 12 forbids hand-editing an applied migration,
-- and rewriting one to make the problem disappear is exactly the habit that rule
-- exists to prevent.
--
-- WHY A SEPARATE TABLE
-- --------------------
-- Sign-in, sign-out, password reset, terms acceptance and session revocation are
-- facts about a person. "Alice signed in at 09:14" does not belong to any
-- organization, and recording it against one would fabricate a tenant
-- association that never happened.
--
-- The two alternatives were both rejected deliberately:
--
--   a) A nullable `organization_id` on `security_audit_events`. Rejected: that
--      table's primary key leads with `organization_id` (ADR 0006), and Prisma
--      cannot put a nullable column in a primary key. Making it nullable would
--      have meant weakening the composite-key rule that keeps every tenant-owned
--      table tenant-scoped, in exchange for events that are not tenant-owned.
--
--   b) One row per membership. Rejected: a user in two organizations would get
--      two "signed in" rows, and a user in none would get none at all - the
--      audit trail would under-report precisely when it matters most.
--
--   c) This table. Identity events are not tenant-owned, so they are not subject
--      to the tenant-scoping rule, and they are recorded exactly once.
--
-- BACKWARD COMPATIBILITY
-- ---------------------
-- Purely additive: one table, three indexes, one foreign key. Nothing existing is
-- read, rewritten or locked beyond the moment the new table is created.
--
-- ROLLBACK
-- --------
--   DROP TABLE identity_audit_events;
-- Safe while empty. Once identity events exist this becomes forward-only, like
-- every other audit table.
--
-- EXECUTION PLAN: same supervised steps as the migration above, minus the enum
-- and empty-table checks. No extension, no exclusive lock on an existing table.
-- ---------------------------------------------------------------------------

-- CreateTable
CREATE TABLE "identity_audit_events" (
    "id" UUID NOT NULL,
    "actor_user_id" UUID NOT NULL,
    "action" VARCHAR(64) NOT NULL,
    "outcome" "AuditOutcome" NOT NULL,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "occurred_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "identity_audit_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "identity_audit_events_actor_user_id_idx" ON "identity_audit_events"("actor_user_id");

-- CreateIndex
CREATE INDEX "identity_audit_events_action_idx" ON "identity_audit_events"("action");

-- CreateIndex
CREATE INDEX "identity_audit_events_occurred_at_idx" ON "identity_audit_events"("occurred_at");

-- AddForeignKey
ALTER TABLE "identity_audit_events" ADD CONSTRAINT "identity_audit_events_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The same append-only guarantee as the organization trail. `REVOKE` would be
-- decorative here for the same reason it was there: the application connects as
-- the table owner and an owner bypasses its own grants.
CREATE TRIGGER identity_audit_events_no_update_delete
    BEFORE UPDATE OR DELETE ON "identity_audit_events"
    FOR EACH ROW EXECUTE FUNCTION security_audit_events_append_only();