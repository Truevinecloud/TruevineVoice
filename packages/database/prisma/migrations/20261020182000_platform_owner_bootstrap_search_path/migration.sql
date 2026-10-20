-- Forward-only hardening; do not edit either previously rehearsed migration.
-- Intentionally UNAPPROVED for production. No privilege grants or row changes.
BEGIN;
-- pg_temp must be explicit and last: otherwise PostgreSQL searches temporary
-- relations before public even when pg_temp is absent from search_path.
ALTER FUNCTION public.validate_platform_owner_bootstrap()
  SET search_path = pg_catalog, public, pg_temp;
COMMIT;
