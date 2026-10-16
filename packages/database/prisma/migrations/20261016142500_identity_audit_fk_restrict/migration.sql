-- ---------------------------------------------------------------------------
-- Make the identity audit trail's user reference honest.
--
-- `identity_audit_events.actor_user_id` was declared `ON DELETE CASCADE`. That
-- was wrong: the append-only trigger refuses a DELETE on this table, so a
-- cascading delete could never complete. Declaring `CASCADE` documented an
-- action that cannot happen and would have misled the next reader into thinking
-- deleting a user cleans up their audit history.
--
-- `RESTRICT` states the real behaviour and fails with a clear constraint error
-- rather than an append-only trigger error, which better explains itself.
--
-- CONSEQUENCE, made explicit rather than left to be discovered: a user who has
-- ever signed in cannot be deleted. There is no user-deletion path in RBAC-001.
-- A right-to-erasure request needs a reviewed procedure, most likely anonymising
-- the user rather than deleting it. Recorded in ADR 0009 as an open decision.
--
-- BACKWARD COMPATIBILITY
-- ---------------------
-- Dropping and recreating the constraint only. No data is read, written or
-- rewritten; the table is empty at this point and stays valid if it is not.
--
-- ROLLBACK
-- --------
--   ALTER TABLE identity_audit_events DROP CONSTRAINT identity_audit_events_actor_user_id_fkey;
--   ALTER TABLE identity_audit_events ADD CONSTRAINT identity_audit_events_actor_user_id_fkey
--     FOREIGN KEY (actor_user_id) REFERENCES users(id) ON DELETE CASCADE ON UPDATE CASCADE;
-- ---------------------------------------------------------------------------

ALTER TABLE "identity_audit_events"
  DROP CONSTRAINT "identity_audit_events_actor_user_id_fkey";

ALTER TABLE "identity_audit_events"
  ADD CONSTRAINT "identity_audit_events_actor_user_id_fkey"
  FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;