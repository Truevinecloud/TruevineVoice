-- Additive platform-owned singleton; no existing identity or role is rewritten.
-- Intentionally UNAPPROVED for production. Code rollback leaves this claim/audit.
BEGIN;

CREATE TABLE "platform_owner_bootstrap" (
  "slot" VARCHAR(32) NOT NULL CHECK ("slot" = 'first_platform_owner'),
  "operation_id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "audit_event_id" UUID NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "platform_owner_bootstrap_pkey" PRIMARY KEY ("slot"),
  CONSTRAINT "platform_owner_bootstrap_operation_id_key" UNIQUE ("operation_id"),
  CONSTRAINT "platform_owner_bootstrap_user_id_key" UNIQUE ("user_id"),
  CONSTRAINT "platform_owner_bootstrap_audit_event_id_key" UNIQUE ("audit_event_id"),
  CONSTRAINT "platform_owner_bootstrap_user_id_fkey" FOREIGN KEY ("user_id")
    REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "platform_owner_bootstrap_audit_event_id_fkey" FOREIGN KEY ("audit_event_id")
    REFERENCES "identity_audit_events"("id") ON DELETE RESTRICT ON UPDATE RESTRICT
);

CREATE TRIGGER platform_owner_bootstrap_append_only
  BEFORE UPDATE OR DELETE ON "platform_owner_bootstrap"
  FOR EACH ROW EXECUTE FUNCTION security_audit_events_append_only();

-- A claim must name a real PLATFORM_OWNER and its successful, attributed audit.
CREATE FUNCTION validate_platform_owner_bootstrap() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM platform_role_assignments
    WHERE user_id = NEW.user_id AND role = 'PLATFORM_OWNER' AND revoked_at IS NULL
  ) OR NOT EXISTS (
    SELECT 1 FROM identity_audit_events
    WHERE id = NEW.audit_event_id AND actor_user_id = NEW.user_id
      AND action = 'platform.owner.bootstrapped' AND outcome = 'SUCCESS'
      AND metadata->>'operationId' = NEW.operation_id::text
      AND metadata->>'subjectUserId' = NEW.user_id::text
      AND metadata->>'actorKind' = 'external_operator'
  ) THEN
    RAISE EXCEPTION 'First-owner bootstrap requires its role and success audit';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER platform_owner_bootstrap_validate
  BEFORE INSERT ON "platform_owner_bootstrap"
  FOR EACH ROW EXECUTE FUNCTION validate_platform_owner_bootstrap();

COMMIT;
