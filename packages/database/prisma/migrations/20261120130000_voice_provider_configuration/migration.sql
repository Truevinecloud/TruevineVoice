CREATE TABLE "voice_provider_configurations" (
    "environment" VARCHAR(10) PRIMARY KEY CHECK ("environment" IN ('SANDBOX', 'PRODUCTION')),
    "username" VARCHAR(128) NOT NULL,
    "voice_number" VARCHAR(16) NOT NULL,
    "ciphertext" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT FALSE,
    "checked_at" TIMESTAMPTZ(3),
    "check_result" VARCHAR(11) CHECK ("check_result" IN ('verified', 'rejected', 'unavailable')),
    "version" INTEGER NOT NULL DEFAULT 1,
    CHECK (("checked_at" IS NULL) = ("check_result" IS NULL)),
    CHECK (NOT "enabled" OR "check_result" IS NOT DISTINCT FROM 'verified')
);
