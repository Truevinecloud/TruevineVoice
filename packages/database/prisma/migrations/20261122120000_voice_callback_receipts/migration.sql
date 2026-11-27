BEGIN;

CREATE TABLE "voice_callback_bindings" (
  "source" varchar(64) NOT NULL,
  "session_id" varchar(160) NOT NULL,
  "organization_id" uuid NOT NULL,
  "attempt_id" uuid NOT NULL,
  PRIMARY KEY ("source", "session_id"),
  FOREIGN KEY ("organization_id", "attempt_id")
    REFERENCES "call_attempts" ("organization_id", "id") ON DELETE RESTRICT
);

CREATE TABLE "voice_callback_receipts" (
  "id" uuid PRIMARY KEY,
  "source" varchar(64) NOT NULL,
  "session_id" varchar(160) NOT NULL,
  "event_key" varchar(64) NOT NULL,
  "requested_state" "CallAttemptState" NOT NULL,
  "occurred_at" timestamptz(3) NOT NULL,
  "received_at" timestamptz(3) NOT NULL DEFAULT now(),
  "next_run_at" timestamptz(3) NOT NULL DEFAULT now(),
  "attempts" integer NOT NULL DEFAULT 0 CHECK ("attempts" BETWEEN 0 AND 8),
  "status" varchar(16) NOT NULL DEFAULT 'pending' CHECK ("status" IN ('pending', 'completed', 'dead')),
  "outcome" varchar(32),
  UNIQUE ("source", "event_key"),
  CHECK (("status" = 'pending' AND "attempts" < 8) OR
         ("status" = 'completed' AND "outcome" IS NOT NULL) OR
         ("status" = 'dead' AND "outcome" IS NOT NULL))
);

CREATE INDEX "voice_callback_receipts_due_idx" ON "voice_callback_receipts" ("status", "next_run_at", "id");
CREATE INDEX "voice_callback_receipts_binding_idx" ON "voice_callback_receipts" ("source", "session_id", "status");

COMMIT;
