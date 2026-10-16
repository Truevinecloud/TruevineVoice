-- ---------------------------------------------------------------------------
-- Organization suspension.
--
-- REVERSIBLE, NOT DESTRUCTIVE.
--
-- An organization is suspended by timestamping `suspended_at`, never by
-- deleting it. `organizations` cannot be deleted once it has audit events anyway
-- (ADR 0009 §10), so a destructive "closure" would be a hard delete that fails
-- for exactly the organizations you most want to close.
--
-- Reversible by clearing the column. No row is removed, so no audit reference is
-- broken and no membership is lost.
--
-- BACKWARD COMPATIBILITY
-- ---------------------
-- One nullable column with no default. Existing rows read as `NULL`, meaning
-- "not suspended", which is exactly the current behaviour - so applying this to
-- a populated database changes nothing until somebody sets the column.
--
-- `ALTER TABLE ... ADD COLUMN ... NULL` takes a brief ACCESS EXCLUSIVE lock to
-- take the catalog snapshot, but does not rewrite the table because there is no
-- default. Expect milliseconds on any plausible organizations table.
--
-- ROLLBACK
-- --------
--   ALTER TABLE organizations DROP COLUMN suspended_at;
-- Reversible while the column is unset. Once a suspension exists, dropping the
-- column silently un-suspends an organization nobody reviewed, so treat this as
-- forward-only from the first suspension onward.
-- ---------------------------------------------------------------------------

ALTER TABLE "organizations" ADD COLUMN "suspended_at" TIMESTAMPTZ(3);

-- The guard looks up membership by organization on every organization-scoped
-- request, so the suspension check rides the same lookup rather than adding a
-- second round trip on the hot path.
CREATE INDEX "organizations_suspended_at_idx" ON "organizations"("suspended_at")
    WHERE "suspended_at" IS NOT NULL;