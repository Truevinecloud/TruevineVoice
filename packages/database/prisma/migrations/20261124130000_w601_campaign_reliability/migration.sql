-- W6-01: durable campaign dispatch state and non-ledger budget reservations.
-- Additive only. Existing rows keep their stored campaign status; older clients
-- ignore the new columns. No wallet entry or financial history is rewritten.
BEGIN;

ALTER TABLE "campaigns"
  ADD COLUMN "dispatch_state" VARCHAR(16) NOT NULL DEFAULT 'RUNNING',
  ADD COLUMN "dispatch_epoch" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "paused_at" TIMESTAMPTZ(3),
  ADD COLUMN "cancelled_at" TIMESTAMPTZ(3),
  ADD COLUMN "dispatch_stop_reason" VARCHAR(40);

-- Existing emergency stops must not appear dispatchable to the new guard.
UPDATE "campaigns"
SET "dispatch_state" = 'CANCELLED',
    "dispatch_stop_reason" = 'emergency_stop',
    "cancelled_at" = "emergency_stopped_at"
WHERE "emergency_stopped_at" IS NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'campaigns_dispatch_state_check') THEN
    ALTER TABLE "campaigns"
      ADD CONSTRAINT "campaigns_dispatch_state_check"
      CHECK ("dispatch_state" IN ('RUNNING', 'PAUSED', 'CANCELLED'));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'campaigns_dispatch_stop_reason_check') THEN
    ALTER TABLE "campaigns"
      ADD CONSTRAINT "campaigns_dispatch_stop_reason_check"
      CHECK (
        "dispatch_stop_reason" IS NULL OR "dispatch_stop_reason" IN (
          'customer_pause', 'customer_cancel', 'insufficient_balance',
          'dispatch_policy_unavailable', 'emergency_stop'
        )
      );
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'campaigns_emergency_stop_dispatch_check') THEN
    ALTER TABLE "campaigns"
      ADD CONSTRAINT "campaigns_emergency_stop_dispatch_check"
      CHECK ("emergency_stopped_at" IS NULL OR "dispatch_state" <> 'RUNNING');
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "campaigns_dispatch_state_idx"
  ON "campaigns" ("organization_id", "dispatch_state");

-- A cancelled or emergency-stopped campaign cannot be restarted by stale code
-- or an accidental status write. The epoch invalidates in-flight dispatch work.
CREATE OR REPLACE FUNCTION "enforce_campaign_dispatch_transitions"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."dispatch_epoch" < OLD."dispatch_epoch" THEN
    RAISE EXCEPTION 'Dispatch epoch cannot decrease.' USING ERRCODE = '23514';
  END IF;

  IF OLD."dispatch_state" = 'CANCELLED' AND NEW."dispatch_state" <> 'CANCELLED' THEN
    RAISE EXCEPTION 'Cancelled campaigns cannot be restarted.' USING ERRCODE = '23514';
  END IF;

  IF OLD."emergency_stopped_at" IS NOT NULL AND NEW."dispatch_state" = 'RUNNING' THEN
    RAISE EXCEPTION 'Emergency-stopped campaigns cannot be restarted.' USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS "campaigns_dispatch_transitions_guard" ON "campaigns";
CREATE TRIGGER "campaigns_dispatch_transitions_guard"
  BEFORE UPDATE OF "dispatch_state", "dispatch_epoch" ON "campaigns"
  FOR EACH ROW EXECUTE FUNCTION "enforce_campaign_dispatch_transitions"();

-- The existing emergency-stop migration makes the marker immutable. This
-- additional trigger marks dispatch cancelled in the same statement, so callers
-- do not need a second write that could fail independently.
CREATE OR REPLACE FUNCTION "enforce_campaign_emergency_dispatch_stop"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."emergency_stopped_at" IS NULL AND NEW."emergency_stopped_at" IS NOT NULL THEN
    NEW."dispatch_state" := 'CANCELLED';
    NEW."dispatch_epoch" := OLD."dispatch_epoch" + 1;
    NEW."dispatch_stop_reason" := 'emergency_stop';
    NEW."cancelled_at" := NEW."emergency_stopped_at";
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS "campaigns_emergency_dispatch_stop_guard" ON "campaigns";
CREATE TRIGGER "campaigns_emergency_dispatch_stop_guard"
  BEFORE UPDATE OF "emergency_stopped_at" ON "campaigns"
  FOR EACH ROW EXECUTE FUNCTION "enforce_campaign_emergency_dispatch_stop"();

CREATE TABLE IF NOT EXISTS "campaign_dispatch_reservations" (
  "organization_id" UUID NOT NULL,
  "id" UUID NOT NULL,
  "attempt_id" UUID NOT NULL,
  "amount_minor" BIGINT NOT NULL CHECK ("amount_minor" >= 0),
  "currency" VARCHAR(3) NOT NULL CHECK ("currency" = 'UGX'),
  "state" VARCHAR(16) NOT NULL DEFAULT 'HELD'
    CHECK ("state" IN ('HELD', 'RELEASED', 'SETTLED')),
  "policy_version" VARCHAR(64) NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  CONSTRAINT "campaign_dispatch_reservations_pkey"
    PRIMARY KEY ("organization_id", "id"),
  CONSTRAINT "campaign_dispatch_reservations_attempt_key"
    UNIQUE ("organization_id", "attempt_id"),
  CONSTRAINT "campaign_dispatch_reservations_attempt_fkey"
    FOREIGN KEY ("organization_id", "attempt_id")
    REFERENCES "call_attempts" ("organization_id", "id") ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS "campaign_dispatch_reservations_state_idx"
  ON "campaign_dispatch_reservations" ("organization_id", "state");

COMMIT;
