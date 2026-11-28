BEGIN;

CREATE TYPE "CallInitiationReconciliationStatus" AS ENUM (
  'NOT_STARTED',
  'INVOKING',
  'CONFIRMED',
  'FAILED_BEFORE_PROVIDER',
  'UNKNOWN'
);

CREATE TABLE "call_initiation_reconciliations" (
  "organization_id" UUID NOT NULL,
  "attempt_id" UUID NOT NULL,
  "status" "CallInitiationReconciliationStatus" NOT NULL DEFAULT 'NOT_STARTED',
  "reconciliation_required" BOOLEAN NOT NULL DEFAULT TRUE,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "call_initiation_reconciliations_pkey"
    PRIMARY KEY ("organization_id", "attempt_id"),
  CONSTRAINT "call_initiation_reconciliations_state_shape" CHECK (
    ("status" IN ('NOT_STARTED', 'INVOKING', 'UNKNOWN') AND "reconciliation_required")
    OR
    ("status" IN ('CONFIRMED', 'FAILED_BEFORE_PROVIDER') AND NOT "reconciliation_required")
  ),
  CONSTRAINT "call_initiation_reconciliations_attempt_fkey"
    FOREIGN KEY ("organization_id", "attempt_id")
    REFERENCES "call_attempts" ("organization_id", "id")
    ON DELETE RESTRICT ON UPDATE NO ACTION
);

CREATE INDEX "call_initiation_reconciliations_required_idx"
  ON "call_initiation_reconciliations" ("organization_id", "reconciliation_required", "updated_at");

CREATE FUNCTION guard_call_initiation_reconciliation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE allowed boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Call initiation reconciliation history is immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW.organization_id IS DISTINCT FROM OLD.organization_id
    OR NEW.attempt_id IS DISTINCT FROM OLD.attempt_id
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'Call initiation reconciliation identity is immutable' USING ERRCODE = '23514';
  END IF;
  allowed := NEW.status = OLD.status OR CASE OLD.status
    WHEN 'NOT_STARTED' THEN NEW.status IN ('INVOKING', 'FAILED_BEFORE_PROVIDER')
    WHEN 'INVOKING' THEN NEW.status IN ('CONFIRMED', 'UNKNOWN')
    ELSE false
  END;
  IF NOT allowed THEN
    RAISE EXCEPTION 'Illegal call initiation reconciliation transition' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER call_initiation_reconciliation_guard
  BEFORE UPDATE OR DELETE ON "call_initiation_reconciliations"
  FOR EACH ROW EXECUTE FUNCTION guard_call_initiation_reconciliation();

CREATE TRIGGER call_initiation_reconciliations_no_truncate
  BEFORE TRUNCATE ON "call_initiation_reconciliations"
  EXECUTE FUNCTION reject_call_history_mutation();

INSERT INTO "call_initiation_reconciliations" (
  "organization_id", "attempt_id", "status", "reconciliation_required"
)
SELECT
  attempt."organization_id",
  attempt."id",
  CASE WHEN EXISTS (
    SELECT 1
    FROM "call_operations" operation
    JOIN "voice_callback_bindings" binding
      ON binding."organization_id" = operation."organization_id"
      AND binding."attempt_id" = operation."attempt_id"
      AND binding."source" = operation."result"->>'bindingSource'
      AND binding."session_id" = operation."result"->>'providerCallId'
    WHERE operation."organization_id" = attempt."organization_id"
      AND operation."attempt_id" = attempt."id"
      AND operation."operation" = 'campaign.call.initiate'
      AND operation."result"->>'providerCallId' IS NOT NULL
  ) THEN 'CONFIRMED'::"CallInitiationReconciliationStatus"
  ELSE 'UNKNOWN'::"CallInitiationReconciliationStatus"
  END,
  NOT EXISTS (
    SELECT 1
    FROM "call_operations" operation
    JOIN "voice_callback_bindings" binding
      ON binding."organization_id" = operation."organization_id"
      AND binding."attempt_id" = operation."attempt_id"
      AND binding."source" = operation."result"->>'bindingSource'
      AND binding."session_id" = operation."result"->>'providerCallId'
    WHERE operation."organization_id" = attempt."organization_id"
      AND operation."attempt_id" = attempt."id"
      AND operation."operation" = 'campaign.call.initiate'
      AND operation."result"->>'providerCallId' IS NOT NULL
  )
FROM "call_attempts" attempt;

COMMIT;
