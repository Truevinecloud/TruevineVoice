-- RBAC-001: reviewed forward-only security constraints. Never repairs customer
-- rows automatically. Operator approval, backup and rehearsal remain required.
-- Rollback: remove these constraints/triggers only after stopping security
-- writers; doing so weakens the invariant and is not an approved live rollback.
BEGIN;
LOCK TABLE organizations, memberships, invitations IN SHARE ROW EXCLUSIVE MODE;
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM organizations o LEFT JOIN memberships m
      ON m.organization_id = o.id AND m.role = 'OWNER'
    GROUP BY o.id HAVING count(m.user_id) <> 1
  ) THEN
    RAISE EXCEPTION 'RBAC-001 migration refused: every existing organization must have exactly one OWNER. Review ownerless/multiple-owner organizations; no rows were changed.';
  END IF;
  IF EXISTS (SELECT 1 FROM invitations i LEFT JOIN users u ON u.id = i.accepted_by_user_id
    WHERE (i.accepted_at IS NULL) <> (i.accepted_by_user_id IS NULL)
      OR (i.accepted_at IS NOT NULL AND (u.id IS NULL OR u.email <> i.email))
      OR i.role = 'OWNER') THEN
    RAISE EXCEPTION 'RBAC-001 migration refused: inconsistent invitation identity, acceptance pair or OWNER invitation. Review affected invitations; no rows were changed.';
  END IF;
END $$;

CREATE UNIQUE INDEX memberships_single_owner ON memberships(organization_id) WHERE role = 'OWNER';

CREATE FUNCTION enforce_exactly_one_owner() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE tenant uuid;
BEGIN
  IF TG_TABLE_NAME = 'organizations' THEN tenant := COALESCE(NEW.id, OLD.id);
  ELSE tenant := COALESCE(NEW.organization_id, OLD.organization_id); END IF;
  IF EXISTS (SELECT 1 FROM organizations WHERE id = tenant) AND
     (SELECT count(*) FROM memberships WHERE organization_id = tenant AND role = 'OWNER') <> 1 THEN
    RAISE EXCEPTION 'Organization must retain exactly one OWNER; use atomic ownership transfer.' USING ERRCODE = '23514';
  END IF;
  -- Moving a membership to a different tenant must also check the source.
  IF TG_TABLE_NAME = 'memberships' THEN
  IF TG_OP = 'UPDATE' AND OLD.organization_id <> NEW.organization_id AND
     EXISTS (SELECT 1 FROM organizations WHERE id = OLD.organization_id) AND
     (SELECT count(*) FROM memberships WHERE organization_id = OLD.organization_id AND role = 'OWNER') <> 1 THEN
    RAISE EXCEPTION 'Source organization must retain exactly one OWNER.' USING ERRCODE = '23514';
  END IF;
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER memberships_exactly_one_owner
  AFTER INSERT OR UPDATE OR DELETE ON memberships DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION enforce_exactly_one_owner();
CREATE CONSTRAINT TRIGGER organizations_exactly_one_owner
  AFTER INSERT ON organizations DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION enforce_exactly_one_owner();

ALTER TABLE invitations ADD CONSTRAINT invitation_acceptance_pair
  CHECK ((accepted_at IS NULL) = (accepted_by_user_id IS NULL));
ALTER TABLE invitations ADD CONSTRAINT invitation_non_owner CHECK (role <> 'OWNER');
CREATE FUNCTION enforce_invitation_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.accepted_at IS NOT NULL AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'Consumed invitation is immutable.' USING ERRCODE = '23514';
  END IF;
  IF NEW.accepted_at IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM users WHERE id = NEW.accepted_by_user_id AND email = NEW.email AND status = 'ACTIVE'
  ) THEN
    RAISE EXCEPTION 'Invitation must be accepted by its intended active email identity.' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER invitations_identity_binding BEFORE INSERT OR UPDATE ON invitations
  FOR EACH ROW EXECUTE FUNCTION enforce_invitation_identity();
COMMIT;
