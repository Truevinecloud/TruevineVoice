-- Migration: 20261123110000_audio_usage_campaign_set_null
-- Allow draft deletion while keeping audio usage accounting append-only.
--
-- audio_asset_usage rows can never be rewritten or deleted by the app, and the
-- original FK used ON DELETE RESTRICT, so deleting any campaign with a usage
-- event failed with P2003. Clear only the campaign reference on delete. The
-- historical usage row stays intact; the insert-time invariant that
-- CAMPAIGN_SELECTED rows name a campaign moves into the trigger below.

ALTER TABLE "audio_asset_usage"
  DROP CONSTRAINT "audio_asset_usage_organization_id_campaign_id_fkey";

ALTER TABLE "audio_asset_usage"
  ADD CONSTRAINT "audio_asset_usage_organization_id_campaign_id_fkey"
  FOREIGN KEY ("organization_id", "campaign_id")
  REFERENCES "campaigns"("organization_id", "id")
  ON DELETE SET NULL ("campaign_id")
  ON UPDATE CASCADE;

-- A cleared campaign_id is now legal for historical CAMPAIGN_SELECTED rows.
ALTER TABLE "audio_asset_usage"
  DROP CONSTRAINT "audio_asset_usage_campaign_selection_reference";

CREATE OR REPLACE FUNCTION reject_audio_asset_usage_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.action = 'CAMPAIGN_SELECTED' AND NEW.campaign_id IS NULL THEN
      RAISE EXCEPTION 'CAMPAIGN_SELECTED usage requires a campaign reference';
    END IF;
    RETURN NEW;
  END IF;

  -- Permit only the FK referential action above: campaign_id goes from a real
  -- id to NULL and every other column is untouched. Application-level rewrites
  -- and deletes stay rejected.
  IF TG_OP = 'UPDATE'
     AND OLD.campaign_id IS NOT NULL
     AND NEW.campaign_id IS NULL
     AND NEW.organization_id IS NOT DISTINCT FROM OLD.organization_id
     AND NEW.id IS NOT DISTINCT FROM OLD.id
     AND NEW.asset_id IS NOT DISTINCT FROM OLD.asset_id
     AND NEW.actor_user_id IS NOT DISTINCT FROM OLD.actor_user_id
     AND NEW.action IS NOT DISTINCT FROM OLD.action
     AND NEW.byte_size IS NOT DISTINCT FROM OLD.byte_size
     AND NEW.duration_ms IS NOT DISTINCT FROM OLD.duration_ms
     AND NEW.tts_character_count IS NOT DISTINCT FROM OLD.tts_character_count
     AND NEW.created_at IS NOT DISTINCT FROM OLD.created_at
  THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'audio_asset_usage is append-only: % is not permitted', TG_OP;
END;
$$;

DROP TRIGGER IF EXISTS audio_asset_usage_no_update_delete ON audio_asset_usage;
CREATE TRIGGER audio_asset_usage_no_update_delete
  BEFORE INSERT OR DELETE OR UPDATE ON audio_asset_usage
  FOR EACH ROW EXECUTE FUNCTION reject_audio_asset_usage_mutation();
