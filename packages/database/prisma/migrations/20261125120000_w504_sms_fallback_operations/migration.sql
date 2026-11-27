BEGIN;

CREATE TABLE "sms_fallback_operations" (
  "organization_id" uuid NOT NULL,
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "campaign_id" uuid NOT NULL,
  "recipient_id" uuid NOT NULL,
  "voice_attempt_id" uuid NOT NULL,
  "phone_e164" varchar(16) NOT NULL,
  "message" text NOT NULL,
  "idempotency_key" varchar(200) NOT NULL,
  "status" varchar(16) NOT NULL DEFAULT 'PENDING' CHECK ("status" IN ('PENDING', 'SENT', 'FAILED', 'UNCERTAIN')),
  "provider_reference" varchar(200),
  "reconciled" boolean NOT NULL DEFAULT FALSE,
  "created_at" timestamptz(3) NOT NULL DEFAULT now(),
  "updated_at" timestamptz(3) NOT NULL DEFAULT now(),

  CONSTRAINT "sms_fallback_operations_pkey" PRIMARY KEY ("organization_id", "id"),
  CONSTRAINT "sms_fallback_operations_org_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "sms_fallback_operations_org_campaign_id_fkey" FOREIGN KEY ("organization_id", "campaign_id") REFERENCES "campaigns" ("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "sms_fallback_operations_org_recipient_id_fkey" FOREIGN KEY ("organization_id", "recipient_id") REFERENCES "campaign_recipients" ("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "sms_fallback_operations_org_voice_attempt_id_fkey" FOREIGN KEY ("organization_id", "voice_attempt_id") REFERENCES "call_attempts" ("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- Maximum one logical fallback SMS per campaign recipient.
-- voice_attempt_id is retained for traceability but is NOT part of the
-- uniqueness constraint: multiple voice attempts for the same recipient
-- must not produce multiple SMS fallbacks.
CREATE UNIQUE INDEX "sms_fallback_operations_org_campaign_recipient_key"
  ON "sms_fallback_operations" ("organization_id", "campaign_id", "recipient_id");

CREATE INDEX "sms_fallback_operations_org_status_created_idx"
  ON "sms_fallback_operations" ("organization_id", "status", "created_at");

COMMIT;
