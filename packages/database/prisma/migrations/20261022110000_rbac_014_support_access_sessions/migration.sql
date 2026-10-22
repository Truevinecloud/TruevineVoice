-- CreateTable
CREATE TABLE "support_access_sessions" (
    "organization_id" UUID NOT NULL,
    "id" UUID NOT NULL,
    "actor_user_id" UUID NOT NULL,
    "auth_session_id" UUID NOT NULL,
    "token_hash" VARCHAR(64) NOT NULL,
    "reason_code" VARCHAR(32) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "revoked_at" TIMESTAMPTZ(3),

    CONSTRAINT "support_access_sessions_pkey" PRIMARY KEY ("organization_id","id")
);

-- CreateIndex
CREATE UNIQUE INDEX "support_access_sessions_token_hash_key" ON "support_access_sessions"("token_hash");

-- CreateIndex
CREATE INDEX "support_access_sessions_actor_user_id_auth_session_id_expir_idx" ON "support_access_sessions"("actor_user_id", "auth_session_id", "expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_user_id_id_key" ON "sessions"("user_id", "id");

-- AddForeignKey
ALTER TABLE "support_access_sessions" ADD CONSTRAINT "support_access_sessions_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_access_sessions" ADD CONSTRAINT "support_access_sessions_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_access_sessions" ADD CONSTRAINT "support_access_sessions_actor_user_id_auth_session_id_fkey" FOREIGN KEY ("actor_user_id", "auth_session_id") REFERENCES "sessions"("user_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Prisma does not model these CHECK constraints. Keep the database guardrails
-- aligned with SupportAccessService's fixed reason allowlist and 15-minute cap.
ALTER TABLE "support_access_sessions"
    ADD CONSTRAINT "support_access_sessions_reason_code_check"
    CHECK ("reason_code" IN ('CUSTOMER_REQUEST', 'INCIDENT_RESPONSE', 'SERVICE_DIAGNOSTIC', 'SECURITY_REVIEW'));

ALTER TABLE "support_access_sessions"
    ADD CONSTRAINT "support_access_sessions_expiry_check"
    CHECK ("expires_at" > "created_at" AND "expires_at" <= "created_at" + INTERVAL '15 minutes');
