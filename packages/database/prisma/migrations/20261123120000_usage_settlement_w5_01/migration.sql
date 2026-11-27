-- W5-01 usage settlement foundation. Additive and unapproved for production.
-- No existing row is updated or deleted. No migration is applied by this change.
-- Usage quotes, usage events and reversals are immutable. Customer debits and
-- reversal credits are ordinary append-only wallet_entries rows; the ledger
-- remains the only balance projection. Provider cost is evidence only.
BEGIN;

ALTER TABLE "voice_callback_bindings"
  ADD CONSTRAINT "voice_callback_bindings_full_key"
  UNIQUE ("source", "session_id", "organization_id", "attempt_id");

CREATE TABLE "voice_usage_quotes" (
  "organization_id" UUID NOT NULL,
  "id" UUID NOT NULL,
  "source" VARCHAR(64) NOT NULL CHECK ("source" IN ('africas-talking', 'fake', 'synthetic')),
  "session_id" VARCHAR(160) NOT NULL CHECK ("session_id" ~ '^[A-Za-z0-9_-]{1,160}$'),
  "attempt_id" UUID NOT NULL,
  "billed_seconds" INTEGER NOT NULL CHECK ("billed_seconds" > 0),
  "rate_per_second_minor" BIGINT NOT NULL CHECK ("rate_per_second_minor" > 0),
  "customer_charge_minor" BIGINT NOT NULL CHECK ("customer_charge_minor" > 0),
  "currency" VARCHAR(3) NOT NULL CHECK ("currency" = 'UGX'),
  "provider_cost_minor" BIGINT CHECK ("provider_cost_minor" >= 0),
  "provider_cost_currency" VARCHAR(3),
  "pricing_version" VARCHAR(64) NOT NULL CHECK ("pricing_version" ~ '^[A-Za-z0-9._:-]{1,64}$'),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "voice_usage_quotes_pkey" PRIMARY KEY ("organization_id", "id"),
  CONSTRAINT "voice_usage_quotes_charge_formula" CHECK (
    "customer_charge_minor" = "rate_per_second_minor" * "billed_seconds"
  ),
  CONSTRAINT "voice_usage_quotes_cost_pair" CHECK (
    ("provider_cost_minor" IS NULL) = ("provider_cost_currency" IS NULL)
  ),
  CONSTRAINT "voice_usage_quotes_provider_currency" CHECK (
    "provider_cost_currency" IS NULL OR "provider_cost_currency" = 'UGX'
  ),
  CONSTRAINT "voice_usage_quotes_organization_fkey" FOREIGN KEY ("organization_id")
    REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "voice_usage_quotes_binding_fkey"
    FOREIGN KEY ("source", "session_id", "organization_id", "attempt_id")
    REFERENCES "voice_callback_bindings"("source", "session_id", "organization_id", "attempt_id")
    ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "voice_usage_quotes_attempt_key"
  ON "voice_usage_quotes"("organization_id", "attempt_id");
CREATE UNIQUE INDEX "voice_usage_quotes_session_key"
  ON "voice_usage_quotes"("source", "session_id");
CREATE INDEX "voice_usage_quotes_organization_created_idx"
  ON "voice_usage_quotes"("organization_id", "created_at", "id");

CREATE TABLE "voice_usage_events" (
  "organization_id" UUID NOT NULL,
  "id" UUID NOT NULL,
  "attempt_id" UUID NOT NULL,
  "source" VARCHAR(64) NOT NULL CHECK ("source" IN ('africas-talking', 'fake', 'synthetic')),
  "session_id" VARCHAR(160) NOT NULL CHECK ("session_id" ~ '^[A-Za-z0-9_-]{1,160}$'),
  "receipt_event_key" VARCHAR(64) NOT NULL CHECK ("receipt_event_key" ~ '^[a-f0-9]{64}$'),
  "quote_id" UUID NOT NULL,
  "debit_entry_id" UUID NOT NULL,
  "billed_seconds" INTEGER NOT NULL CHECK ("billed_seconds" > 0),
  "rate_per_second_minor" BIGINT NOT NULL CHECK ("rate_per_second_minor" > 0),
  "customer_charge_minor" BIGINT NOT NULL CHECK ("customer_charge_minor" > 0),
  "currency" VARCHAR(3) NOT NULL CHECK ("currency" = 'UGX'),
  "provider_cost_minor" BIGINT CHECK ("provider_cost_minor" >= 0),
  "provider_cost_currency" VARCHAR(3),
  "pricing_version" VARCHAR(64) NOT NULL CHECK ("pricing_version" ~ '^[A-Za-z0-9._:-]{1,64}$'),
  "state" "CallAttemptState" NOT NULL CHECK ("state" = 'COMPLETED'),
  "occurred_at" TIMESTAMPTZ(3) NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "voice_usage_events_pkey" PRIMARY KEY ("organization_id", "id"),
  CONSTRAINT "voice_usage_events_charge_formula" CHECK (
    "customer_charge_minor" = "rate_per_second_minor" * "billed_seconds"
  ),
  CONSTRAINT "voice_usage_events_cost_pair" CHECK (
    ("provider_cost_minor" IS NULL) = ("provider_cost_currency" IS NULL)
  ),
  CONSTRAINT "voice_usage_events_provider_currency" CHECK (
    "provider_cost_currency" IS NULL OR "provider_cost_currency" = 'UGX'
  ),
  CONSTRAINT "voice_usage_events_quote_fkey" FOREIGN KEY ("organization_id", "quote_id")
    REFERENCES "voice_usage_quotes"("organization_id", "id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "voice_usage_events_debit_fkey" FOREIGN KEY ("organization_id", "debit_entry_id")
    REFERENCES "wallet_entries"("organization_id", "id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "voice_usage_events_binding_fkey"
    FOREIGN KEY ("source", "session_id", "organization_id", "attempt_id")
    REFERENCES "voice_callback_bindings"("source", "session_id", "organization_id", "attempt_id")
    ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "voice_usage_events_event_key_key"
  ON "voice_usage_events"("organization_id", "receipt_event_key");
CREATE UNIQUE INDEX "voice_usage_events_source_event_key_key"
  ON "voice_usage_events"("source", "receipt_event_key");
-- One trusted quote must fund at most one charge, even when a duplicate
-- callback arrives with a different event key.
CREATE UNIQUE INDEX "voice_usage_events_quote_key"
  ON "voice_usage_events"("organization_id", "quote_id");
CREATE INDEX "voice_usage_events_organization_created_idx"
  ON "voice_usage_events"("organization_id", "created_at", "id");

CREATE TABLE "voice_usage_reversals" (
  "organization_id" UUID NOT NULL,
  "id" UUID NOT NULL,
  "usage_event_id" UUID NOT NULL,
  "credit_entry_id" UUID NOT NULL,
  "reason" VARCHAR(200) NOT NULL CHECK (length(trim("reason")) BETWEEN 3 AND 200),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "voice_usage_reversals_pkey" PRIMARY KEY ("organization_id", "id"),
  CONSTRAINT "voice_usage_reversals_usage_fkey" FOREIGN KEY ("organization_id", "usage_event_id")
    REFERENCES "voice_usage_events"("organization_id", "id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "voice_usage_reversals_credit_fkey" FOREIGN KEY ("organization_id", "credit_entry_id")
    REFERENCES "wallet_entries"("organization_id", "id")
    ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "voice_usage_reversals_usage_key"
  ON "voice_usage_reversals"("organization_id", "usage_event_id");

CREATE FUNCTION reject_w5_usage_history_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Usage settlement history is append-only';
END;
$$;
CREATE TRIGGER voice_usage_quotes_append_only BEFORE UPDATE OR DELETE ON "voice_usage_quotes"
  FOR EACH ROW EXECUTE FUNCTION reject_w5_usage_history_mutation();
CREATE TRIGGER voice_usage_quotes_no_truncate BEFORE TRUNCATE ON "voice_usage_quotes"
  FOR EACH STATEMENT EXECUTE FUNCTION reject_w5_usage_history_mutation();
CREATE TRIGGER voice_usage_events_append_only BEFORE UPDATE OR DELETE ON "voice_usage_events"
  FOR EACH ROW EXECUTE FUNCTION reject_w5_usage_history_mutation();
CREATE TRIGGER voice_usage_events_no_truncate BEFORE TRUNCATE ON "voice_usage_events"
  FOR EACH STATEMENT EXECUTE FUNCTION reject_w5_usage_history_mutation();
CREATE TRIGGER voice_usage_reversals_append_only BEFORE UPDATE OR DELETE ON "voice_usage_reversals"
  FOR EACH ROW EXECUTE FUNCTION reject_w5_usage_history_mutation();
CREATE TRIGGER voice_usage_reversals_no_truncate BEFORE TRUNCATE ON "voice_usage_reversals"
  FOR EACH STATEMENT EXECUTE FUNCTION reject_w5_usage_history_mutation();

COMMIT;
