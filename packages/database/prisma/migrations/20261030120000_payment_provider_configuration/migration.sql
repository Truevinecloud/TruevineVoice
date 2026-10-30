-- ---------------------------------------------------------------------------
-- Payment-provider credential configuration (MTN MoMo / Airtel Money).
--
-- PURELY ADDITIVE. Two enums, one platform-owned table, one foreign key and
-- several integrity constraints. Nothing existing is read, rewritten or locked
-- beyond the moment the new table is created.
--
-- WHY NOT TENANT-OWNED
-- --------------------
-- A payment-provider account belongs to Truevine. It has no organization_id and
-- no customer-facing endpoint reaches it. The platform permission registry
-- grants `platform:payments:*` to PLATFORM_OWNER alone.
--
-- WHY THE CIPHERTEXT IS ONE COLUMN
-- --------------------------------
-- `credentials_ciphertext` is an AES-256-GCM envelope that includes the nonce,
-- authentication tag and ciphertext. The key is supplied at boot through
-- `PAYMENT_CREDENTIAL_ENCRYPTION_KEY`; there is no default and no key material
-- in this migration. `credential_fields` carries field names only, which is what
-- lets a read report "configured" without decrypting a value.
--
-- ACTIVATION IS EXPLICIT
-- ----------------------
-- `active` defaults to false and is only set by the activation endpoint. The
-- CHECK below requires an encrypted credential set and a callback URL before a
-- row can be active, and the partial unique index allows at most one active
-- environment per provider. Saving credentials never flips either column.
--
-- ROLLBACK
-- --------
--   DROP TABLE payment_provider_configurations;
--   DROP TYPE "PaymentProviderEnvironment";
--   DROP TYPE "PaymentProvider";
-- Safe while empty. Once credentials exist this becomes forward-only: the
-- encrypted values cannot be reconstructed from an audit trail.
-- ---------------------------------------------------------------------------

-- CreateEnum
CREATE TYPE "PaymentProvider" AS ENUM ('MTN_MOMO', 'AIRTEL_MONEY');

-- CreateEnum
CREATE TYPE "PaymentProviderEnvironment" AS ENUM ('SANDBOX', 'PRODUCTION');

-- CreateTable
CREATE TABLE "payment_provider_configurations" (
    "id" UUID NOT NULL,
    "provider" "PaymentProvider" NOT NULL,
    "environment" "PaymentProviderEnvironment" NOT NULL,
    "credentials_ciphertext" TEXT,
    -- Prisma's scalar-list DDL is a nullable array with an empty default; the
    -- CHECK below treats NULL as "no fields" so the integrity rule still holds.
    "credential_fields" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "callback_url" VARCHAR(512),
    "active" BOOLEAN NOT NULL DEFAULT false,
    "configured_at" TIMESTAMPTZ(3),
    "activated_at" TIMESTAMPTZ(3),
    "deactivated_at" TIMESTAMPTZ(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "updated_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "payment_provider_configurations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "payment_provider_configurations_provider_environment_key"
    ON "payment_provider_configurations"("provider", "environment");

-- CreateIndex
CREATE INDEX "payment_provider_configurations_provider_active_idx"
    ON "payment_provider_configurations"("provider", "active");

-- At most one environment may be active for a provider. Switching environments
-- is therefore a deliberate deactivate-then-activate sequence, never two live
-- credential sets at once.
CREATE UNIQUE INDEX "payment_provider_configurations_one_active_per_provider"
    ON "payment_provider_configurations"("provider")
    WHERE "active";

-- AddForeignKey
ALTER TABLE "payment_provider_configurations"
    ADD CONSTRAINT "payment_provider_configurations_updated_by_user_id_fkey"
    FOREIGN KEY ("updated_by_user_id") REFERENCES "users"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- Credential presence is internally consistent: a configured row always has an
-- encrypted envelope and at least one named field; an unconfigured row has none.
ALTER TABLE "payment_provider_configurations"
    ADD CONSTRAINT "payment_provider_configurations_credentials_presence"
    CHECK (
        ("configured_at" IS NULL AND "credentials_ciphertext" IS NULL AND coalesce(cardinality("credential_fields"), 0) = 0)
        OR
        ("configured_at" IS NOT NULL AND "credentials_ciphertext" IS NOT NULL AND coalesce(cardinality("credential_fields"), 0) > 0)
    );

-- Activation is impossible without a usable credential set and callback target.
ALTER TABLE "payment_provider_configurations"
    ADD CONSTRAINT "payment_provider_configurations_active_requires_credentials"
    CHECK (
        NOT "active"
        OR ("credentials_ciphertext" IS NOT NULL AND "callback_url" IS NOT NULL)
    );

-- `activated_at`/`deactivated_at` describe the current activation cycle. Audit
-- history, not this row, carries the sequence of earlier activations.
ALTER TABLE "payment_provider_configurations"
    ADD CONSTRAINT "payment_provider_configurations_activation_timestamps"
    CHECK (
        ("active" AND "activated_at" IS NOT NULL AND "deactivated_at" IS NULL)
        OR
        (NOT "active" AND ("activated_at" IS NULL OR "deactivated_at" IS NOT NULL))
    );

-- A callback URL is configuration, not a secret. Query strings and fragments are
-- refused so the URL cannot become an unreviewed place to hide a routing token.
ALTER TABLE "payment_provider_configurations"
    ADD CONSTRAINT "payment_provider_configurations_callback_url_https"
    CHECK ("callback_url" IS NULL OR "callback_url" ~ '^https://[^[:space:]#?]+$');

-- Optimistic concurrency starts at one and only increases.
ALTER TABLE "payment_provider_configurations"
    ADD CONSTRAINT "payment_provider_configurations_version_positive"
    CHECK ("version" > 0);
