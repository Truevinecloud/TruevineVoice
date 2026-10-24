-- CreateEnum
CREATE TYPE "AudioAssetSource" AS ENUM ('RECORDING', 'TTS');

-- CreateEnum
CREATE TYPE "AudioAssetOperationState" AS ENUM ('PENDING', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "AudioAssetUsageAction" AS ENUM ('RECORDING_CREATED', 'TTS_GENERATED', 'CAMPAIGN_SELECTED', 'PLAYBACK_LINK_ISSUED');

-- AlterTable
ALTER TABLE "campaigns" ADD COLUMN     "audio_asset_id" UUID,
ADD COLUMN     "audio_organization_id" UUID;

-- CreateTable
CREATE TABLE "audio_assets" (
    "organization_id" UUID NOT NULL,
    "id" UUID NOT NULL,
    "created_by_user_id" UUID NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "source" "AudioAssetSource" NOT NULL,
    "mime_type" VARCHAR(64) NOT NULL,
    "storage_key" VARCHAR(512) NOT NULL,
    "checksum_sha256" CHAR(64) NOT NULL,
    "byte_size" BIGINT NOT NULL,
    "duration_ms" INTEGER,
    "tts_provider" VARCHAR(64),
    "tts_voice" VARCHAR(64),
    "tts_character_count" INTEGER,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audio_assets_pkey" PRIMARY KEY ("organization_id","id")
);

-- CreateTable
CREATE TABLE "audio_asset_operations" (
    "organization_id" UUID NOT NULL,
    "id" UUID NOT NULL,
    "idempotency_key" VARCHAR(200) NOT NULL,
    "created_by_user_id" UUID NOT NULL,
    "source" "AudioAssetSource" NOT NULL,
    "request_fingerprint" CHAR(64) NOT NULL,
    "state" "AudioAssetOperationState" NOT NULL DEFAULT 'PENDING',
    "asset_organization_id" UUID,
    "asset_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ(3),

    CONSTRAINT "audio_asset_operations_pkey" PRIMARY KEY ("organization_id","id")
);

-- CreateTable
CREATE TABLE "audio_asset_usage" (
    "organization_id" UUID NOT NULL,
    "id" UUID NOT NULL,
    "asset_id" UUID NOT NULL,
    "actor_user_id" UUID NOT NULL,
    "action" "AudioAssetUsageAction" NOT NULL,
    "byte_size" BIGINT NOT NULL,
    "duration_ms" INTEGER,
    "tts_character_count" INTEGER,
    "campaign_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audio_asset_usage_pkey" PRIMARY KEY ("organization_id","id")
);

-- CreateIndex
CREATE INDEX "audio_assets_organization_id_created_at_id_idx" ON "audio_assets"("organization_id", "created_at", "id");

-- CreateIndex
CREATE UNIQUE INDEX "audio_assets_organization_id_storage_key_key" ON "audio_assets"("organization_id", "storage_key");

-- CreateIndex
CREATE INDEX "audio_asset_operations_organization_id_state_created_at_idx" ON "audio_asset_operations"("organization_id", "state", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "audio_asset_operations_organization_id_idempotency_key_key" ON "audio_asset_operations"("organization_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "audio_asset_usage_organization_id_asset_id_created_at_idx" ON "audio_asset_usage"("organization_id", "asset_id", "created_at");

-- AddForeignKey
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_audio_organization_id_audio_asset_id_fkey" FOREIGN KEY ("audio_organization_id", "audio_asset_id") REFERENCES "audio_assets"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audio_assets" ADD CONSTRAINT "audio_assets_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audio_assets" ADD CONSTRAINT "audio_assets_organization_id_created_by_user_id_fkey" FOREIGN KEY ("organization_id", "created_by_user_id") REFERENCES "memberships"("organization_id", "user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audio_asset_operations" ADD CONSTRAINT "audio_asset_operations_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audio_asset_operations" ADD CONSTRAINT "audio_asset_operations_organization_id_created_by_user_id_fkey" FOREIGN KEY ("organization_id", "created_by_user_id") REFERENCES "memberships"("organization_id", "user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audio_asset_operations" ADD CONSTRAINT "audio_asset_operations_asset_organization_id_asset_id_fkey" FOREIGN KEY ("asset_organization_id", "asset_id") REFERENCES "audio_assets"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audio_asset_usage" ADD CONSTRAINT "audio_asset_usage_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audio_asset_usage" ADD CONSTRAINT "audio_asset_usage_organization_id_asset_id_fkey" FOREIGN KEY ("organization_id", "asset_id") REFERENCES "audio_assets"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audio_asset_usage" ADD CONSTRAINT "audio_asset_usage_organization_id_actor_user_id_fkey" FOREIGN KEY ("organization_id", "actor_user_id") REFERENCES "memberships"("organization_id", "user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audio_asset_usage" ADD CONSTRAINT "audio_asset_usage_organization_id_campaign_id_fkey" FOREIGN KEY ("organization_id", "campaign_id") REFERENCES "campaigns"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Keep campaign references wholly within the campaign tenant.
ALTER TABLE "campaigns" ADD CONSTRAINT "campaign_audio_reference_consistency"
  CHECK (("audio_asset_id" IS NULL AND "audio_organization_id" IS NULL)
      OR ("audio_asset_id" IS NOT NULL AND "audio_organization_id" = "organization_id"));

ALTER TABLE "audio_assets"
  ADD CONSTRAINT "audio_assets_byte_size_bounds" CHECK ("byte_size" BETWEEN 1 AND 10485760),
  ADD CONSTRAINT "audio_assets_duration_bounds" CHECK ("duration_ms" IS NULL OR "duration_ms" BETWEEN 1 AND 300000),
  ADD CONSTRAINT "audio_assets_storage_key_tenant_prefix" CHECK ("storage_key" LIKE "organization_id"::text || '/audio/%'),
  ADD CONSTRAINT "audio_assets_tts_metadata_consistency"
    CHECK (("source" = 'RECORDING' AND "tts_provider" IS NULL AND "tts_voice" IS NULL AND "tts_character_count" IS NULL)
        OR ("source" = 'TTS' AND "tts_provider" IS NOT NULL AND "tts_voice" IS NOT NULL AND "tts_character_count" IS NOT NULL AND "tts_character_count" BETWEEN 1 AND 3000));

-- A result asset belongs to the operation tenant, and only completed operations have one.
ALTER TABLE "audio_asset_operations"
  ADD CONSTRAINT "audio_operation_asset_pair_consistency"
    CHECK (("asset_organization_id" IS NULL AND "asset_id" IS NULL)
        OR ("asset_organization_id" = "organization_id" AND "asset_id" IS NOT NULL)),
  ADD CONSTRAINT "audio_operation_completion_consistency"
    CHECK (("state" = 'COMPLETED' AND "asset_id" IS NOT NULL)
        OR ("state" <> 'COMPLETED' AND "asset_id" IS NULL));

-- Usage is an append-only record; retain provider and access evidence.
CREATE FUNCTION reject_audio_asset_usage_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audio_asset_usage is append-only: % is not permitted', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;
CREATE TRIGGER audio_asset_usage_no_update_delete
  BEFORE UPDATE OR DELETE ON "audio_asset_usage"
  FOR EACH ROW EXECUTE FUNCTION reject_audio_asset_usage_mutation();
CREATE TRIGGER audio_asset_usage_no_truncate
  BEFORE TRUNCATE ON "audio_asset_usage"
  FOR EACH STATEMENT EXECUTE FUNCTION reject_audio_asset_usage_mutation();
ALTER TABLE "audio_asset_usage"
  ADD CONSTRAINT "audio_asset_usage_byte_size_bounds" CHECK ("byte_size" BETWEEN 1 AND 10485760),
  ADD CONSTRAINT "audio_asset_usage_duration_bounds" CHECK ("duration_ms" IS NULL OR "duration_ms" BETWEEN 1 AND 300000),
  ADD CONSTRAINT "audio_asset_usage_campaign_selection_reference"
    CHECK ("action" <> 'CAMPAIGN_SELECTED' OR "campaign_id" IS NOT NULL),
  ADD CONSTRAINT "audio_asset_usage_tts_character_reference"
    CHECK ("action" <> 'TTS_GENERATED' OR ("tts_character_count" IS NOT NULL AND "tts_character_count" BETWEEN 1 AND 3000));

