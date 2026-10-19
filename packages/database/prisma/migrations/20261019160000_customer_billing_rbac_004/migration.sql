-- RBAC-004: additive, unapproved for production. No existing data is changed.
-- UGX only; integer minor units. No customer endpoint can insert wallet credits.
-- Retain the append-only triggers and CHECKs in future generated migrations.
CREATE TABLE "wallet_entries" (
  "organization_id" UUID NOT NULL,
  "id" UUID NOT NULL,
  "amount_minor" BIGINT NOT NULL CHECK ("amount_minor" <> 0),
  "currency" VARCHAR(3) NOT NULL CHECK ("currency" = 'UGX'),
  "reference" VARCHAR(200) NOT NULL,
  "description" VARCHAR(500) NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "wallet_entries_pkey" PRIMARY KEY ("organization_id", "id"),
  CONSTRAINT "wallet_entries_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "wallet_entries_organization_id_reference_key" ON "wallet_entries"("organization_id", "reference");
CREATE INDEX "wallet_entries_organization_id_created_at_id_idx" ON "wallet_entries"("organization_id", "created_at", "id");

CREATE TABLE "top_up_requests" (
  "organization_id" UUID NOT NULL,
  "id" UUID NOT NULL,
  "idempotency_key" UUID NOT NULL,
  "amount_minor" BIGINT NOT NULL CHECK ("amount_minor" > 0),
  "currency" VARCHAR(3) NOT NULL CHECK ("currency" = 'UGX'),
  "created_by_user_id" UUID NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "top_up_requests_pkey" PRIMARY KEY ("organization_id", "id"),
  CONSTRAINT "top_up_requests_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "top_up_requests_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "top_up_requests_organization_id_idempotency_key_key" ON "top_up_requests"("organization_id", "idempotency_key");
CREATE INDEX "top_up_requests_organization_id_created_at_id_idx" ON "top_up_requests"("organization_id", "created_at", "id");

CREATE TABLE "billing_profiles" (
  "organization_id" UUID NOT NULL,
  "name" VARCHAR(200) NOT NULL,
  "email" VARCHAR(254) NOT NULL,
  "address" VARCHAR(500) NOT NULL,
  CONSTRAINT "billing_profiles_pkey" PRIMARY KEY ("organization_id"),
  CONSTRAINT "billing_profiles_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE FUNCTION reject_billing_history_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Billing history is append-only';
END;
$$;
CREATE TRIGGER wallet_entries_append_only BEFORE UPDATE OR DELETE ON "wallet_entries"
FOR EACH ROW EXECUTE FUNCTION reject_billing_history_mutation();
CREATE TRIGGER wallet_entries_no_truncate BEFORE TRUNCATE ON "wallet_entries"
FOR EACH STATEMENT EXECUTE FUNCTION reject_billing_history_mutation();
CREATE TRIGGER top_up_requests_append_only BEFORE UPDATE OR DELETE ON "top_up_requests"
FOR EACH ROW EXECUTE FUNCTION reject_billing_history_mutation();
CREATE TRIGGER top_up_requests_no_truncate BEFORE TRUNCATE ON "top_up_requests"
FOR EACH STATEMENT EXECUTE FUNCTION reject_billing_history_mutation();
