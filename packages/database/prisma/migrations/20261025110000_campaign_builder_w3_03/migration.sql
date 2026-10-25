BEGIN;

-- AlterTable
ALTER TABLE "campaigns" ADD COLUMN     "retry_delay_minutes" INTEGER NOT NULL DEFAULT 60,
ADD COLUMN     "retry_max_attempts" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "scheduled_at" TIMESTAMPTZ(3);

-- Keep retry bounds enforced by PostgreSQL as well as by the API.
ALTER TABLE "campaigns"
    ADD CONSTRAINT "campaigns_retry_max_attempts_bounds"
        CHECK ("retry_max_attempts" BETWEEN 1 AND 5),
    ADD CONSTRAINT "campaigns_retry_delay_minutes_bounds"
        CHECK ("retry_delay_minutes" BETWEEN 5 AND 1440);

-- CreateTable
CREATE TABLE "campaign_audience_groups" (
    "organization_id" UUID NOT NULL,
    "campaign_id" UUID NOT NULL,
    "group_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "campaign_audience_groups_pkey" PRIMARY KEY ("organization_id","campaign_id","group_id")
);

-- CreateIndex
CREATE INDEX "campaign_audience_groups_organization_id_group_id_campaign__idx" ON "campaign_audience_groups"("organization_id", "group_id", "campaign_id");

-- AddForeignKey
ALTER TABLE "campaign_audience_groups" ADD CONSTRAINT "campaign_audience_groups_organization_id_campaign_id_fkey" FOREIGN KEY ("organization_id", "campaign_id") REFERENCES "campaigns"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_audience_groups" ADD CONSTRAINT "campaign_audience_groups_organization_id_group_id_fkey" FOREIGN KEY ("organization_id", "group_id") REFERENCES "contact_groups"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

COMMIT;

