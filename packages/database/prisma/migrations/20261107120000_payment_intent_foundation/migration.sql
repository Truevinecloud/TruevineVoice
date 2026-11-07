-- Payment intent persistence foundation (Step 2A.1). Additive only.
-- Existing wallet entries remain valid; payment_intent_id is nullable.
BEGIN;

ALTER TABLE "wallet_entries"
  ADD COLUMN "payment_intent_id" UUID;

CREATE TABLE "payment_intents" (
  "organization_id" UUID NOT NULL,
  "id" UUID NOT NULL,
  "purpose" VARCHAR(32) NOT NULL,
  "amount_minor" BIGINT NOT NULL CHECK ("amount_minor" > 0),
  "currency" VARCHAR(3) NOT NULL CHECK ("currency" = 'UGX'),
  "status" VARCHAR(32) NOT NULL,
  "idempotency_key" UUID NOT NULL,
  "provider" VARCHAR(32),
  "environment" VARCHAR(16),
  "provider_reference" VARCHAR(200),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "payment_intents_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "payment_intents_organization_id_id_key" UNIQUE ("organization_id", "id"),
  CONSTRAINT "payment_intents_organization_id_idempotency_key_key" UNIQUE ("organization_id", "idempotency_key"),
  CONSTRAINT "payment_intents_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "payment_intents_organization_id_created_at_id_idx" ON "payment_intents"("organization_id", "created_at", "id");

CREATE TABLE "payment_attempts" (
  "id" UUID NOT NULL,
  "payment_intent_id" UUID NOT NULL,
  "organization_id" UUID NOT NULL,
  "attempt_no" INTEGER NOT NULL,
  "provider" VARCHAR(32) NOT NULL,
  "environment" VARCHAR(16) NOT NULL,
  "provider_reference" VARCHAR(200),
  "status" VARCHAR(32) NOT NULL,
  "request_fingerprint" VARCHAR(128) NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completed_at" TIMESTAMPTZ(3),
  CONSTRAINT "payment_attempts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "payment_attempts_payment_intent_id_attempt_no_key" UNIQUE ("payment_intent_id", "attempt_no"),
  CONSTRAINT "payment_attempts_provider_environment_provider_reference_key" UNIQUE ("provider", "environment", "provider_reference"),
  CONSTRAINT "payment_attempts_payment_intent_id_fkey" FOREIGN KEY ("organization_id", "payment_intent_id") REFERENCES "payment_intents"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "payment_attempts_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "payment_attempts_organization_id_created_at_idx" ON "payment_attempts"("organization_id", "created_at");

CREATE TABLE "payment_provider_events" (
  "id" UUID NOT NULL,
  "payment_intent_id" UUID,
  "organization_id" UUID,
  "provider" VARCHAR(32) NOT NULL,
  "environment" VARCHAR(16) NOT NULL,
  "provider_event_id" VARCHAR(200) NOT NULL,
  "status" VARCHAR(32) NOT NULL,
  "verified" BOOLEAN NOT NULL DEFAULT FALSE,
  "payload_redacted" JSONB,
  "received_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "payment_provider_events_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "payment_provider_events_provider_environment_provider_event_id_key" UNIQUE ("provider", "environment", "provider_event_id"),
  CONSTRAINT "payment_provider_events_payment_intent_id_fkey" FOREIGN KEY ("payment_intent_id") REFERENCES "payment_intents"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "payment_provider_events_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "payment_provider_events_organization_id_payment_intent_id_fkey" FOREIGN KEY ("organization_id", "payment_intent_id") REFERENCES "payment_intents"("organization_id", "id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX "payment_provider_events_organization_id_received_at_idx" ON "payment_provider_events"("organization_id", "received_at");

-- Composite FK from wallet_entries to payment_intents (nullable).
ALTER TABLE "wallet_entries"
  ADD CONSTRAINT "wallet_entries_organization_id_payment_intent_id_fkey"
  FOREIGN KEY ("organization_id", "payment_intent_id")
  REFERENCES "payment_intents"("organization_id", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- One credit per payment intent.
CREATE UNIQUE INDEX "wallet_entries_organization_id_payment_intent_id_key"
  ON "wallet_entries"("organization_id", "payment_intent_id");

COMMIT;
