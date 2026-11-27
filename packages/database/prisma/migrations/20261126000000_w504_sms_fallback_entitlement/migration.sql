BEGIN;

-- W5-04: Organization-level SMS entitlement.
-- Disabled by default. Only a platform administrator may grant entitlement
-- through a dedicated administrative endpoint (not implemented in this change).
ALTER TABLE "organizations"
  ADD COLUMN "sms_entitled" boolean NOT NULL DEFAULT FALSE;

-- W5-04: Campaign-level SMS fallback configuration.
-- Disabled by default. A campaign administrator may enable fallback only when
-- the organization has SMS entitlement.
ALTER TABLE "campaigns"
  ADD COLUMN "sms_fallback_enabled" boolean NOT NULL DEFAULT FALSE;

ALTER TABLE "campaigns"
  ADD COLUMN "sms_fallback_message" text;

-- W5-04: Contact-level SMS consent. Unknown consent (null) denies dispatch.
ALTER TABLE "contacts"
  ADD COLUMN "sms_consent" boolean;

-- Index for efficient lookup of SMS-entitled organizations.
CREATE INDEX "organizations_org_sms_entitled_idx"
  ON "organizations" ("sms_entitled")
  WHERE "sms_entitled" = TRUE;

-- Index for efficient lookup of campaigns with SMS fallback enabled.
CREATE INDEX "campaigns_org_sms_fallback_enabled_idx"
  ON "campaigns" ("sms_fallback_enabled")
  WHERE "sms_fallback_enabled" = TRUE;

COMMIT;
