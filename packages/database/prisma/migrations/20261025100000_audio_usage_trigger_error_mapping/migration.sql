-- Correct the driver error mapping for the append-only usage trigger.
-- The initial migration used SQLSTATE 23001 (restrict_violation), which Prisma
-- maps to a foreign-key error. The default PL/pgSQL exception state P0001
-- preserves the append-only explanation for callers and regression tests.
CREATE OR REPLACE FUNCTION reject_audio_asset_usage_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audio_asset_usage is append-only: % is not permitted', TG_OP;
END;
$$;
