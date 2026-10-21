-- Additive only. Not approved for production. Keep custom constraints/triggers on regeneration.
BEGIN;
-- CreateEnum
CREATE TYPE "CallAttemptState" AS ENUM ('QUEUED', 'DIALING', 'RINGING', 'ANSWERED', 'COMPLETED', 'FAILED', 'BUSY', 'NO_ANSWER', 'CANCELLED', 'TIMEOUT');

-- CreateTable
CREATE TABLE "contacts" (
    "organization_id" UUID NOT NULL,
    "id" UUID NOT NULL,
    "destination" VARCHAR(16) NOT NULL,
    "label" VARCHAR(200) NOT NULL DEFAULT '',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "contacts_pkey" PRIMARY KEY ("organization_id","id")
);

-- CreateTable
CREATE TABLE "campaign_recipients" (
    "organization_id" UUID NOT NULL,
    "id" UUID NOT NULL,
    "campaign_id" UUID NOT NULL,
    "contact_id" UUID NOT NULL,
    "destination" VARCHAR(16) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "campaign_recipients_pkey" PRIMARY KEY ("organization_id","id")
);

-- CreateTable
CREATE TABLE "campaign_executions" (
    "organization_id" UUID NOT NULL,
    "id" UUID NOT NULL,
    "campaign_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "campaign_executions_pkey" PRIMARY KEY ("organization_id","id")
);

-- CreateTable
CREATE TABLE "call_attempts" (
    "organization_id" UUID NOT NULL,
    "id" UUID NOT NULL,
    "campaign_id" UUID NOT NULL,
    "execution_id" UUID NOT NULL,
    "recipient_id" UUID NOT NULL,
    "destination" VARCHAR(16) NOT NULL,
    "attempt_number" INTEGER NOT NULL,
    "previous_attempt_id" UUID,
    "redial_reason" VARCHAR(200),
    "state" "CallAttemptState" NOT NULL DEFAULT 'QUEUED',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "call_attempts_pkey" PRIMARY KEY ("organization_id","id")
);

-- CreateTable
CREATE TABLE "call_operations" (
    "organization_id" UUID NOT NULL,
    "operation" VARCHAR(40) NOT NULL,
    "key" VARCHAR(200) NOT NULL,
    "fingerprint_version" INTEGER NOT NULL,
    "fingerprint" VARCHAR(64) NOT NULL,
    "attempt_id" UUID NOT NULL,
    "result" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "call_operations_pkey" PRIMARY KEY ("organization_id","operation","key")
);

-- CreateTable
CREATE TABLE "call_events" (
    "organization_id" UUID NOT NULL,
    "id" UUID NOT NULL,
    "attempt_id" UUID NOT NULL,
    "event_key" VARCHAR(200) NOT NULL,
    "fingerprint" VARCHAR(64) NOT NULL,
    "requested_state" "CallAttemptState" NOT NULL,
    "disposition" VARCHAR(24) NOT NULL,
    "provider_usage" JSONB,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL,
    "received_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "call_events_pkey" PRIMARY KEY ("organization_id","id")
);

-- CreateIndex
CREATE UNIQUE INDEX "campaign_recipients_organization_id_campaign_id_contact_id_key" ON "campaign_recipients"("organization_id", "campaign_id", "contact_id");

-- CreateIndex
CREATE UNIQUE INDEX "campaign_recipients_organization_id_campaign_id_id_key" ON "campaign_recipients"("organization_id", "campaign_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "campaign_executions_organization_id_campaign_id_key" ON "campaign_executions"("organization_id", "campaign_id");

-- CreateIndex
CREATE UNIQUE INDEX "campaign_executions_organization_id_campaign_id_id_key" ON "campaign_executions"("organization_id", "campaign_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "call_attempts_organization_id_execution_id_recipient_id_att_key" ON "call_attempts"("organization_id", "execution_id", "recipient_id", "attempt_number");

-- CreateIndex
CREATE UNIQUE INDEX "call_attempts_organization_id_execution_id_recipient_id_id_key" ON "call_attempts"("organization_id", "execution_id", "recipient_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "call_attempts_organization_id_previous_attempt_id_key" ON "call_attempts"("organization_id", "previous_attempt_id");

-- CreateIndex
CREATE INDEX "call_events_organization_id_attempt_id_event_key_idx" ON "call_events"("organization_id", "attempt_id", "event_key");

-- CreateIndex
CREATE INDEX "call_events_organization_id_disposition_received_at_idx" ON "call_events"("organization_id", "disposition", "received_at");

-- AddForeignKey
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_recipients" ADD CONSTRAINT "campaign_recipients_organization_id_campaign_id_fkey" FOREIGN KEY ("organization_id", "campaign_id") REFERENCES "campaigns"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_recipients" ADD CONSTRAINT "campaign_recipients_organization_id_contact_id_fkey" FOREIGN KEY ("organization_id", "contact_id") REFERENCES "contacts"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_executions" ADD CONSTRAINT "campaign_executions_organization_id_campaign_id_fkey" FOREIGN KEY ("organization_id", "campaign_id") REFERENCES "campaigns"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "call_attempts" ADD CONSTRAINT "call_attempts_organization_id_campaign_id_execution_id_fkey" FOREIGN KEY ("organization_id", "campaign_id", "execution_id") REFERENCES "campaign_executions"("organization_id", "campaign_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "call_attempts" ADD CONSTRAINT "call_attempts_organization_id_campaign_id_recipient_id_fkey" FOREIGN KEY ("organization_id", "campaign_id", "recipient_id") REFERENCES "campaign_recipients"("organization_id", "campaign_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "call_attempts" ADD CONSTRAINT "call_attempts_organization_id_execution_id_recipient_id_pr_fkey" FOREIGN KEY ("organization_id", "execution_id", "recipient_id", "previous_attempt_id") REFERENCES "call_attempts"("organization_id", "execution_id", "recipient_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "call_operations" ADD CONSTRAINT "call_operations_organization_id_attempt_id_fkey" FOREIGN KEY ("organization_id", "attempt_id") REFERENCES "call_attempts"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "call_events" ADD CONSTRAINT "call_events_organization_id_attempt_id_fkey" FOREIGN KEY ("organization_id", "attempt_id") REFERENCES "call_attempts"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Reviewed custom integrity controls: Prisma cannot express these checks/triggers.
ALTER TABLE contacts ADD CONSTRAINT contacts_e164 CHECK(destination ~ '^\+[1-9][0-9]{0,14}$');
ALTER TABLE campaign_recipients ADD CONSTRAINT recipients_e164 CHECK(destination ~ '^\+[1-9][0-9]{0,14}$');
ALTER TABLE call_attempts ADD CONSTRAINT attempts_e164 CHECK(destination ~ '^\+[1-9][0-9]{0,14}$');
ALTER TABLE call_attempts ADD CONSTRAINT attempts_redial_shape CHECK(
  (attempt_number=1 AND previous_attempt_id IS NULL AND redial_reason IS NULL) OR
  (attempt_number>1 AND previous_attempt_id IS NOT NULL AND redial_reason IS NOT NULL AND length(btrim(redial_reason)) BETWEEN 1 AND 200));
ALTER TABLE call_operations ADD CONSTRAINT operations_request_shape CHECK(
  operation='call.accept' AND fingerprint_version=1 AND fingerprint ~ '^[0-9a-f]{64}$'
  AND length(btrim(key)) BETWEEN 1 AND 200 AND key=btrim(key));
ALTER TABLE call_events ADD CONSTRAINT events_shape CHECK(
  disposition IN ('APPLIED','DUPLICATE','CONFLICT','ILLEGAL') AND fingerprint ~ '^[0-9a-f]{64}$'
  AND length(btrim(event_key)) BETWEEN 1 AND 200);

CREATE FUNCTION reject_call_history_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Call history is immutable' USING ERRCODE='23514';
END $$;
CREATE TRIGGER recipients_immutable BEFORE UPDATE OR DELETE ON campaign_recipients
  FOR EACH ROW EXECUTE FUNCTION reject_call_history_mutation();
CREATE TRIGGER executions_immutable BEFORE UPDATE OR DELETE ON campaign_executions
  FOR EACH ROW EXECUTE FUNCTION reject_call_history_mutation();
CREATE TRIGGER operations_immutable BEFORE UPDATE OR DELETE ON call_operations
  FOR EACH ROW EXECUTE FUNCTION reject_call_history_mutation();
CREATE TRIGGER events_append_only BEFORE UPDATE OR DELETE ON call_events
  FOR EACH ROW EXECUTE FUNCTION reject_call_history_mutation();

CREATE FUNCTION validate_recipient_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM contacts WHERE organization_id=NEW.organization_id
    AND id=NEW.contact_id AND destination=NEW.destination) THEN
    RAISE EXCEPTION 'Recipient must snapshot its tenant contact' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER recipient_snapshot BEFORE INSERT ON campaign_recipients
  FOR EACH ROW EXECUTE FUNCTION validate_recipient_snapshot();

CREATE FUNCTION guard_call_attempt() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE prior call_attempts%ROWTYPE;
allowed boolean;
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'Call attempt history is immutable' USING ERRCODE='23514';
  END IF;
  IF TG_OP='INSERT' THEN
    -- Serialize even direct writers; uniqueness alone cannot enforce the redial sequence.
    PERFORM 1 FROM campaign_executions WHERE organization_id=NEW.organization_id
      AND id=NEW.execution_id AND campaign_id=NEW.campaign_id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Unknown scoped execution' USING ERRCODE='23503';
    END IF;
    IF NEW.state <> 'QUEUED' THEN
      RAISE EXCEPTION 'New attempt must be queued' USING ERRCODE='23514';
    END IF;
    IF NOT EXISTS(SELECT 1 FROM campaign_recipients WHERE organization_id=NEW.organization_id
      AND id=NEW.recipient_id AND campaign_id=NEW.campaign_id AND destination=NEW.destination) THEN
      RAISE EXCEPTION 'Attempt must retain recipient snapshot' USING ERRCODE='23514';
    END IF;
    SELECT * INTO prior FROM call_attempts WHERE organization_id=NEW.organization_id
      AND execution_id=NEW.execution_id AND recipient_id=NEW.recipient_id
      ORDER BY attempt_number DESC LIMIT 1 FOR UPDATE;
    IF FOUND THEN
      IF NEW.previous_attempt_id IS DISTINCT FROM prior.id OR NEW.attempt_number<>prior.attempt_number+1
        OR prior.state NOT IN ('COMPLETED','FAILED','BUSY','NO_ANSWER','CANCELLED','TIMEOUT') THEN
        RAISE EXCEPTION 'Redial requires latest terminal attempt' USING ERRCODE='23514';
      END IF;
    ELSIF NEW.attempt_number<>1 OR NEW.previous_attempt_id IS NOT NULL THEN
      RAISE EXCEPTION 'Initial attempt must be first' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW)-'state') IS DISTINCT FROM (to_jsonb(OLD)-'state') THEN
    RAISE EXCEPTION 'Accepted attempt identity is immutable' USING ERRCODE='23514';
  END IF;
  allowed := NEW.state=OLD.state OR CASE OLD.state
    WHEN 'QUEUED' THEN NEW.state IN ('DIALING','CANCELLED','FAILED','TIMEOUT')
    WHEN 'DIALING' THEN NEW.state IN ('RINGING','ANSWERED','BUSY','NO_ANSWER','FAILED','CANCELLED','TIMEOUT')
    WHEN 'RINGING' THEN NEW.state IN ('ANSWERED','BUSY','NO_ANSWER','FAILED','CANCELLED','TIMEOUT')
    WHEN 'ANSWERED' THEN NEW.state IN ('COMPLETED','FAILED','TIMEOUT')
    ELSE false END;
  IF NOT allowed THEN
    RAISE EXCEPTION 'Illegal call state transition' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER attempts_guard BEFORE INSERT OR UPDATE OR DELETE ON call_attempts
  FOR EACH ROW EXECUTE FUNCTION guard_call_attempt();

-- TRUNCATE bypasses row triggers; reject it on all immutable history tables.
CREATE TRIGGER recipients_no_truncate BEFORE TRUNCATE ON campaign_recipients
  EXECUTE FUNCTION reject_call_history_mutation();
CREATE TRIGGER executions_no_truncate BEFORE TRUNCATE ON campaign_executions
  EXECUTE FUNCTION reject_call_history_mutation();
CREATE TRIGGER attempts_no_truncate BEFORE TRUNCATE ON call_attempts
  EXECUTE FUNCTION reject_call_history_mutation();
CREATE TRIGGER operations_no_truncate BEFORE TRUNCATE ON call_operations
  EXECUTE FUNCTION reject_call_history_mutation();
CREATE TRIGGER events_no_truncate BEFORE TRUNCATE ON call_events
  EXECUTE FUNCTION reject_call_history_mutation();

COMMIT;
