-- Separate migration: the preceding bootstrap migration was already exercised
-- in disposable PostgreSQL. Preserve its contents and add this guard forward.
-- Intentionally UNAPPROVED for production.
BEGIN;
CREATE TRIGGER platform_owner_bootstrap_no_truncate
  BEFORE TRUNCATE ON "platform_owner_bootstrap"
  FOR EACH STATEMENT EXECUTE FUNCTION security_audit_events_append_only();
COMMIT;
