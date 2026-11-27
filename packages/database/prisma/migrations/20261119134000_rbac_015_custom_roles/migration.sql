-- ---------------------------------------------------------------------------
-- RBAC-015 Custom roles, permissions and assignments.
--
-- PURELY ADDITIVE. Three tables, one enum, no existing table or column touched.
-- Nothing existing is read, rewritten or locked beyond the moment the new
-- tables are created.
--
-- TENANCY
-- -------
-- Every table is tenant-owned: each composite primary key leads with
-- `organization_id` (ADR 0006), so a row cannot exist without an organization
-- and a cross-tenant id guess resolves to nothing. Foreign keys carry
-- `organization_id` alongside the parent id so a role, permission or assignment
-- from another tenant cannot be referenced.
--
-- SYSTEM ROLES ARE UNTOUCHED
-- --------------------------
-- The built-in membership roles (OWNER, ADMIN, CAMPAIGN_MANAGER, BILLING,
-- VIEWER) live only in the `@truevine/auth` registry and in the `memberships`
-- table's `MembershipRole` enum. This migration does not alter either. Custom
-- roles are evaluated by a separate RBAC-015 authorization function, never by
-- `can(role, permission)` for a built-in role.
--
-- ROLLBACK
-- --------
--   DROP TABLE role_assignments;
--   DROP TABLE role_permissions;
--   DROP TABLE custom_roles;
--   DROP TYPE "RoleType";
-- Safe while empty.
-- ---------------------------------------------------------------------------

-- CreateEnum
CREATE TYPE "RoleType" AS ENUM ('SYSTEM', 'CUSTOM');

-- CreateTable
CREATE TABLE "custom_roles" (
    "organization_id" UUID NOT NULL,
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" VARCHAR(120) NOT NULL,
    "description" TEXT,
    "type" "RoleType" NOT NULL DEFAULT 'CUSTOM',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "custom_roles_pkey" PRIMARY KEY ("organization_id", "id")
);

-- CreateIndex
CREATE UNIQUE INDEX "custom_roles_organization_id_name_key"
    ON "custom_roles"("organization_id", "name");

CREATE INDEX "custom_roles_organization_id_type_idx"
    ON "custom_roles"("organization_id", "type");

-- CreateTable
CREATE TABLE "role_permissions" (
    "organization_id" UUID NOT NULL,
    "role_id" UUID NOT NULL,
    "permission" VARCHAR(64) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "role_permissions_pkey" PRIMARY KEY ("organization_id", "role_id", "permission")
);

-- CreateIndex
CREATE INDEX "role_permissions_organization_id_role_id_idx"
    ON "role_permissions"("organization_id", "role_id");

-- AddForeignKey
ALTER TABLE "role_permissions"
    ADD CONSTRAINT "role_permissions_organization_id_role_id_fkey"
    FOREIGN KEY ("organization_id", "role_id") REFERENCES "custom_roles"("organization_id", "id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "role_assignments" (
    "organization_id" UUID NOT NULL,
    "role_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "role_assignments_pkey" PRIMARY KEY ("organization_id", "role_id", "user_id")
);

-- CreateIndex
CREATE INDEX "role_assignments_organization_id_user_id_idx"
    ON "role_assignments"("organization_id", "user_id");

-- AddForeignKey
ALTER TABLE "role_assignments"
    ADD CONSTRAINT "role_assignments_organization_id_role_id_fkey"
    FOREIGN KEY ("organization_id", "role_id") REFERENCES "custom_roles"("organization_id", "id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_assignments"
    ADD CONSTRAINT "role_assignments_organization_id_user_id_fkey"
    FOREIGN KEY ("organization_id", "user_id") REFERENCES "memberships"("organization_id", "user_id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- A custom role can only be assigned to a member of the same organization. The
-- composite foreign key above already enforces this, and the CHECK below makes
-- the intent explicit: no assignment may reference an organization that does not
-- own the role. (Redundant with the FK, but documents the rule for reviewers.)
ALTER TABLE "custom_roles"
    ADD CONSTRAINT "custom_roles_organization_exists"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
