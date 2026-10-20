-- RBAC-007: persist an emergency campaign stop so organization roles cannot
-- reactivate a stopped campaign through the existing campaign status endpoint.
-- Additive only; no campaign data is rewritten.
BEGIN;

ALTER TABLE "campaigns"
  ADD COLUMN "emergency_stopped_at" TIMESTAMPTZ(3);

-- Store emergency stops as COMPLETED plus an immutable marker so the currently
-- deployed Prisma client continues to read the existing enum values safely.
-- Older application versions cannot clear the marker or restart the campaign.
CREATE FUNCTION "enforce_campaign_emergency_stop"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."emergency_stopped_at" IS NULL AND NEW."emergency_stopped_at" IS NOT NULL
     AND OLD."status" <> 'ACTIVE' THEN
    RAISE EXCEPTION 'Emergency stop requires an active campaign.' USING ERRCODE = '23514';
  END IF;

  IF OLD."emergency_stopped_at" IS NOT NULL
     AND NEW."emergency_stopped_at" IS DISTINCT FROM OLD."emergency_stopped_at" THEN
    RAISE EXCEPTION 'Emergency stop marker is immutable.' USING ERRCODE = '23514';
  END IF;

  IF OLD."emergency_stopped_at" IS NOT NULL AND NEW."status" <> 'COMPLETED' THEN
    RAISE EXCEPTION 'Emergency-stopped campaign cannot be restarted.' USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "campaigns_emergency_stop_guard"
BEFORE UPDATE OF "status", "emergency_stopped_at" ON "campaigns"
FOR EACH ROW EXECUTE FUNCTION "enforce_campaign_emergency_stop"();

COMMIT;
