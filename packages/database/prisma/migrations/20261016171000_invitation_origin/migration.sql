-- RBAC-001 follow-up: scope new invitation authors to their organization.
-- Separate migration because security_atomicity has already been rehearsed.
-- Historical invitations intentionally survive later member removal.
-- Additive trigger; no customer rows are rewritten. Production approval remains
-- manual. Rollback removes this trigger/function only under stopped writers;
-- that weakens authorization and is not an approved automatic rollback.
BEGIN;
CREATE FUNCTION enforce_invitation_origin() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Leave unknown-organization errors to the existing organization FK.
  IF NOT EXISTS (SELECT 1 FROM organizations WHERE id = NEW.organization_id) THEN RETURN NEW; END IF;
  PERFORM 1 FROM memberships
    WHERE organization_id = NEW.organization_id AND user_id = NEW.invited_by_user_id
    FOR KEY SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invitation author must belong to its organization.' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER invitations_origin_binding BEFORE INSERT ON invitations
  FOR EACH ROW EXECUTE FUNCTION enforce_invitation_origin();
COMMIT;
