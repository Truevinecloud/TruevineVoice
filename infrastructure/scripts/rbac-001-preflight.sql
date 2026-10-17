-- ===========================================================================
-- Truevine Voice — RBAC-001 production preflight (READ ONLY).
--
-- Answers one question before anyone touches the migration ledger:
--   is this database safe to migrate with the RBAC-001 migrations, and is any
--   part of RBAC-001 already applied?
--
-- SAFETY
-- ------
-- This file only reads. It opens a READ ONLY transaction, sets a short
-- statement/lock timeout so it can never block production writers for long, and
-- ends with ROLLBACK. Running it cannot modify data, schema or the ledger. It
-- is safe to run against production. It is NOT a migration.
--
-- USAGE (on the VPS, against the live container; role and database as deployed):
--   docker exec -i truevine-postgres \
--     psql -v ON_ERROR_STOP=1 -U truevine -d truevine_voice -f - \
--     < infrastructure/scripts/rbac-001-preflight.sql
--
-- HOW TO READ THE OUTPUT
-- ----------------------
-- Rows are pipe-delimited and tagged:
--   GATE|<name>|<value>|<expected>   value must equal expected, else STOP.
--   LEDGER|<migration>|<state>       applied | in_progress_or_failed | rolled_back
--   ENUM|MembershipRole|<labels>     pre-swap: OWNER,ADMIN,OPERATOR,VIEWER
--   COUNT|<table>|<n>                row counts that gate the destructive swap.
--   OBJECT|<name>|<present|absent>   partial-application detector.
--   INVARIANT|<name>|<ok|detail>     refuses the migration if not "ok".
--   INFO|<key>|<value>
-- NOTICE lines from the DO block report the invitation invariants on stderr;
-- redirect with 2>&1 to see them interleaved.
--
-- A GATE whose value is not the expected one, any LEDGER row that is not
-- "applied", or any INVARIANT that is not "ok" is a STOP. Do not migrate until
-- a human has reviewed it. See docs/runbooks/rbac-001-staging-rehearsal.md.
-- ===========================================================================

\set ON_ERROR_STOP on
\pset pager off
\pset tuples_only on
\pset format unaligned
\pset fieldsep '|'

BEGIN;
SET TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '30s';
SET LOCAL lock_timeout = '5s';

\echo ## environment
SELECT 'INFO', 'server_version', current_setting('server_version');
SELECT 'INFO', 'database', current_database();
SELECT 'INFO', 'current_role', current_user;
SELECT 'INFO', 'in_recovery', pg_is_in_recovery()::text;
SELECT 'INFO', 'statement_timeout', current_setting('statement_timeout');

\echo ## citext availability
SELECT 'OBJECT', 'extension:citext',
       CASE WHEN EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'citext')
            THEN 'present' ELSE 'absent' END;
SELECT 'INFO', 'citext_installable',
       CASE WHEN EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'citext')
            THEN 'yes' ELSE 'no' END;
SELECT 'INFO', 'current_role_superuser',
       (SELECT rolsuper::text FROM pg_roles WHERE rolname = current_user);

\echo ## migration ledger (tenancy_core + the six RBAC-001 migrations)
SELECT 'LEDGER', migration_name,
       CASE WHEN rolled_back_at IS NOT NULL THEN 'rolled_back'
            WHEN finished_at IS NULL THEN 'in_progress_or_failed'
            ELSE 'applied' END
FROM _prisma_migrations
WHERE migration_name IN (
  '20261014042915_tenancy_core',
  '20261016130500_identity_rbac_001',
  '20261016141500_identity_audit_events',
  '20261016142500_identity_audit_fk_restrict',
  '20261016153000_organization_suspension',
  '20261016170000_security_atomicity',
  '20261016171000_invitation_origin'
)
ORDER BY migration_name;

\echo ## any migration that is not cleanly applied
SELECT 'LEDGER', migration_name,
       CASE WHEN rolled_back_at IS NOT NULL THEN 'rolled_back' ELSE 'failed' END
FROM _prisma_migrations
WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL
ORDER BY migration_name;

\echo ## MembershipRole enum (pre-swap has OPERATOR and no CAMPAIGN_MANAGER)
SELECT 'ENUM', 'MembershipRole',
       COALESCE((SELECT string_agg(enumlabel, ',' ORDER BY enumsortorder)
                 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
                 WHERE t.typname = 'MembershipRole'), '<absent>');

\echo ## row counts that gate the destructive enum swap
SELECT 'COUNT', 'organizations', count(*)::text FROM organizations;
SELECT 'COUNT', 'memberships', count(*)::text FROM memberships;
SELECT 'GATE', 'enum_swap_safe',
       CASE WHEN (SELECT count(*) FROM organizations) = 0
             AND (SELECT count(*) FROM memberships) = 0
            THEN 'yes' ELSE 'no' END,
       'yes';

\echo ## owner invariant (security_atomicity refuses any violation)
SELECT 'INVARIANT', 'organizations_exactly_one_owner',
       COALESCE((SELECT string_agg(o.id::text, ',')
                 FROM organizations o
                 LEFT JOIN memberships m
                   ON m.organization_id = o.id AND m.role = 'OWNER'
                 GROUP BY o.id
                 HAVING count(m.user_id) <> 1), 'ok'),
       'ok';

\echo ## invitation invariants (only meaningful once invitations exists)
DO $$
DECLARE
  bad_owner integer;
  bad_pair integer;
  bad_identity integer;
BEGIN
  IF to_regclass('public.invitations') IS NULL THEN
    RAISE NOTICE 'INVARIANT|invitations|n/a|table absent (not yet migrated)';
    RETURN;
  END IF;
  EXECUTE $q$SELECT count(*) FROM invitations WHERE role = 'OWNER'$q$ INTO bad_owner;
  EXECUTE $q$SELECT count(*) FROM invitations
               WHERE (accepted_at IS NULL) <> (accepted_by_user_id IS NULL)$q$ INTO bad_pair;
  EXECUTE $q$SELECT count(*) FROM invitations i
                LEFT JOIN users u ON u.id = i.accepted_by_user_id
               WHERE i.accepted_at IS NOT NULL
                 AND (u.id IS NULL OR u.email <> i.email)$q$ INTO bad_identity;
  RAISE NOTICE 'INVARIANT|invitations_owner|%',
    CASE WHEN bad_owner = 0 THEN 'ok' ELSE bad_owner::text || ' OWNER invitation(s)' END;
  RAISE NOTICE 'INVARIANT|invitations_acceptance_pair|%',
    CASE WHEN bad_pair = 0 THEN 'ok' ELSE bad_pair::text || ' inconsistent row(s)' END;
  RAISE NOTICE 'INVARIANT|invitations_identity|%',
    CASE WHEN bad_identity = 0 THEN 'ok' ELSE bad_identity::text || ' mismatched row(s)' END;
END $$;

\echo ## RBAC object presence (partial-application detector)
SELECT 'OBJECT', name,
       CASE WHEN to_regclass('public.' || name) IS NOT NULL
            THEN 'present' ELSE 'absent' END
FROM (VALUES
  ('users'),
  ('sessions'),
  ('password_reset_tokens'),
  ('terms_acceptances'),
  ('platform_role_assignments'),
  ('invitations'),
  ('security_audit_events'),
  ('identity_audit_events')
) AS t(name)
ORDER BY name;

SELECT 'OBJECT', 'memberships_user_id_fkey',
       CASE WHEN EXISTS (SELECT 1 FROM pg_constraint
                         WHERE conname = 'memberships_user_id_fkey')
            THEN 'present' ELSE 'absent' END;
SELECT 'OBJECT', 'index:memberships_single_owner',
       CASE WHEN to_regclass('public.memberships_single_owner') IS NOT NULL
            THEN 'present' ELSE 'absent' END;
SELECT 'OBJECT', 'organizations.suspended_at',
       CASE WHEN EXISTS (SELECT 1 FROM information_schema.columns
                         WHERE table_schema = 'public'
                           AND table_name = 'organizations'
                           AND column_name = 'suspended_at')
            THEN 'present' ELSE 'absent' END;

ROLLBACK;

\echo ## end of preflight — transaction rolled back, nothing changed
