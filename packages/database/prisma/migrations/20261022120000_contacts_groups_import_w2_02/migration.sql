-- W2-02: extend the existing campaign contacts table without replacing rows,
-- IDs, destination/label fields, or campaign-recipient relationships.
BEGIN;
CREATE TYPE "ContactImportStatus" AS ENUM ('OPEN', 'COMPLETED');

ALTER TABLE "contacts"
  ADD COLUMN "phone_e164" VARCHAR(16),
  ADD COLUMN "email" VARCHAR(254),
  ADD COLUMN "voice_consent_at" TIMESTAMPTZ(3),
  ADD COLUMN "voice_consent_source" VARCHAR(80),
  ADD COLUMN "voice_consent_purpose" VARCHAR(40),
  ADD COLUMN "voice_consent_evidence_reference" VARCHAR(128),
  ADD COLUMN "voice_consent_verified_by_user_id" UUID,
  ADD COLUMN "suppressed_at" TIMESTAMPTZ(3),
  ADD COLUMN "suppression_reason" VARCHAR(120),
  ADD COLUMN "created_by_user_id" UUID;

ALTER TABLE "contacts"
  ADD CONSTRAINT "contacts_phone_e164_check"
    CHECK ("phone_e164" IS NULL OR "phone_e164" ~ '^\+[1-9][0-9]{0,14}$'),
  ADD CONSTRAINT "contacts_organization_id_created_by_user_id_fkey"
    FOREIGN KEY ("organization_id", "created_by_user_id") REFERENCES "memberships"("organization_id", "user_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "contacts_organization_id_voice_consent_verified_by_user_id_fkey"
    FOREIGN KEY ("organization_id", "voice_consent_verified_by_user_id") REFERENCES "memberships"("organization_id", "user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE UNIQUE INDEX "contacts_organization_id_phone_e164_key"
  ON "contacts"("organization_id", "phone_e164");
CREATE INDEX "contacts_organization_id_suppressed_at_voice_consent_at_idx"
  ON "contacts"("organization_id", "suppressed_at", "voice_consent_at");

CREATE TABLE "contact_groups" (
  "organization_id" UUID NOT NULL,
  "id" UUID NOT NULL,
  "name" VARCHAR(120) NOT NULL,
  "normalized_name" VARCHAR(120) NOT NULL,
  "created_by_user_id" UUID NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "contact_groups_pkey" PRIMARY KEY ("organization_id", "id"),
  CONSTRAINT "contact_groups_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "contact_groups_organization_id_created_by_user_id_fkey" FOREIGN KEY ("organization_id", "created_by_user_id") REFERENCES "memberships"("organization_id", "user_id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "contact_groups_organization_id_normalized_name_key"
  ON "contact_groups"("organization_id", "normalized_name");
CREATE INDEX "contact_groups_organization_id_name_idx"
  ON "contact_groups"("organization_id", "name");

CREATE TABLE "contact_group_members" (
  "organization_id" UUID NOT NULL,
  "group_id" UUID NOT NULL,
  "contact_id" UUID NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "contact_group_members_pkey" PRIMARY KEY ("organization_id", "group_id", "contact_id"),
  CONSTRAINT "contact_group_members_group_fkey" FOREIGN KEY ("organization_id", "group_id") REFERENCES "contact_groups"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "contact_group_members_contact_fkey" FOREIGN KEY ("organization_id", "contact_id") REFERENCES "contacts"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "contact_group_members_organization_id_contact_id_idx"
  ON "contact_group_members"("organization_id", "contact_id");

CREATE TABLE "contact_imports" (
  "organization_id" UUID NOT NULL,
  "id" UUID NOT NULL,
  "created_by_user_id" UUID NOT NULL,
  "mapping" JSONB NOT NULL,
  "status" "ContactImportStatus" NOT NULL DEFAULT 'OPEN',
  "next_batch_number" INTEGER NOT NULL DEFAULT 0,
  "rows_processed" INTEGER NOT NULL DEFAULT 0,
  "created_count" INTEGER NOT NULL DEFAULT 0,
  "updated_count" INTEGER NOT NULL DEFAULT 0,
  "unchanged_count" INTEGER NOT NULL DEFAULT 0,
  "rejected_count" INTEGER NOT NULL DEFAULT 0,
  "warning_count" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completed_at" TIMESTAMPTZ(3),
  CONSTRAINT "contact_imports_pkey" PRIMARY KEY ("organization_id", "id"),
  CONSTRAINT "contact_imports_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "contact_imports_organization_id_created_by_user_id_fkey" FOREIGN KEY ("organization_id", "created_by_user_id") REFERENCES "memberships"("organization_id", "user_id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "contact_imports_organization_id_created_at_idx"
  ON "contact_imports"("organization_id", "created_at");

CREATE TABLE "contact_import_batches" (
  "organization_id" UUID NOT NULL,
  "import_id" UUID NOT NULL,
  "batch_number" INTEGER NOT NULL,
  "payload_hash" CHAR(64) NOT NULL,
  "report" JSONB NOT NULL,
  "row_count" INTEGER NOT NULL,
  "created_count" INTEGER NOT NULL,
  "updated_count" INTEGER NOT NULL,
  "unchanged_count" INTEGER NOT NULL,
  "rejected_count" INTEGER NOT NULL,
  "warning_count" INTEGER NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "contact_import_batches_pkey" PRIMARY KEY ("organization_id", "import_id", "batch_number"),
  CONSTRAINT "contact_import_batches_import_fkey" FOREIGN KEY ("organization_id", "import_id") REFERENCES "contact_imports"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE
);
COMMIT;