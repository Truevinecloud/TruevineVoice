-- RBAC-013: row triggers do not intercept TRUNCATE.
-- Additive, no historical-row rewrite. Existing UPDATE/DELETE guards remain.
-- Requires brief table DDL locks; controlled executor's lock_timeout applies.
-- Code rollback retains these protections; no automatic down migration.
BEGIN;
CREATE TRIGGER security_audit_events_no_truncate
  BEFORE TRUNCATE ON security_audit_events
  FOR EACH STATEMENT EXECUTE FUNCTION security_audit_events_append_only();
CREATE TRIGGER identity_audit_events_no_truncate
  BEFORE TRUNCATE ON identity_audit_events
  FOR EACH STATEMENT EXECUTE FUNCTION security_audit_events_append_only();
COMMIT;
