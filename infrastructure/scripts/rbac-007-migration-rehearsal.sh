#!/usr/bin/env bash
set -Eeuo pipefail

# This rehearsal is intentionally limited to the PostgreSQL container started by
# the CI job's repository docker-compose.yml. It refuses to run outside Actions.
if [[ "${GITHUB_ACTIONS:-}" != "true" ]]; then
  echo "Refusing migration rehearsal outside GitHub Actions." >&2
  exit 2
fi

database='rbac007_migration_rehearsal'
lock_error_file=''
psql_ci() {
  docker compose exec -T postgres psql -v ON_ERROR_STOP=1 -U truevine "$@"
}

cleanup() {
  if [[ -n "${lock_error_file:-}" ]]; then rm -f -- "$lock_error_file"; fi
  psql_ci -d postgres -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${database}' AND pid <> pg_backend_pid();" >/dev/null || true
  psql_ci -d postgres -c "DROP DATABASE IF EXISTS ${database};" >/dev/null || true
}
trap cleanup EXIT

# The fixed name is checked here and never accepted from the environment.
cleanup
psql_ci -d postgres -c "CREATE DATABASE ${database};" >/dev/null
psql_ci -d "$database" <<'SQL'
CREATE TYPE "CampaignStatus" AS ENUM ('DRAFT', 'ACTIVE', 'COMPLETED');
CREATE TABLE "campaigns" ("status" "CampaignStatus" NOT NULL);
INSERT INTO "campaigns" ("status") VALUES ('ACTIVE');
SQL

migration='packages/database/prisma/migrations/20261020110000_rbac_007_emergency_stop/migration.sql'
set +e
awk '$0 == "COMMIT;" { print "SELECT 1 / 0;" } { print }' "$migration" |
  psql_ci -d "$database" >/dev/null 2>&1
forced_failure=$?
set -e
if [[ "$forced_failure" -eq 0 ]]; then
  echo "Forced failure unexpectedly succeeded." >&2
  exit 1
fi

rolled_back="$(psql_ci -d "$database" -Atc "SELECT count(*) FROM information_schema.columns WHERE table_name='campaigns' AND column_name='emergency_stopped_at';")"
if [[ "$rolled_back" != '0' ]]; then
  echo "Failed migration left the marker column behind." >&2
  exit 1
fi

# A held ACCESS SHARE lock blocks RBAC-007 ALTER TABLE until lock_timeout aborts it.
psql_ci -d "$database" -c "BEGIN; LOCK TABLE campaigns IN ACCESS SHARE MODE; SELECT pg_sleep(8); COMMIT;" >/dev/null &
blocker_pid=$!
lock_acquired=false
for attempt in $(seq 1 50); do
  lock_count="$(psql_ci -d "$database" -Atc "SELECT count(*) FROM pg_locks l JOIN pg_class c ON c.oid=l.relation WHERE c.relname='campaigns' AND l.mode='AccessShareLock' AND l.granted;")"
  if [[ "$lock_count" -gt 0 ]]; then lock_acquired=true; break; fi
  sleep 0.1
done
if [[ "$lock_acquired" != true ]]; then
  echo "Could not establish the disposable campaign lock for the rehearsal." >&2
  wait "$blocker_pid" || true
  exit 1
fi
lock_error_file="$(mktemp)"
set +e
{ printf "SET lock_timeout = '5s';\n"; cat "$migration"; } | docker compose exec -T postgres psql -v ON_ERROR_STOP=1 -v VERBOSITY=verbose -U truevine -d "$database" >/dev/null 2>"$lock_error_file"
lock_timeout_status=$?
set -e
if [[ "$lock_timeout_status" -eq 0 ]] || ! grep -q '55P03.*lock timeout' "$lock_error_file"; then
  echo "RBAC-007 migration did not fail specifically with lock_not_available under the conflicting lock." >&2
  wait "$blocker_pid" || true
  exit 1
fi
wait "$blocker_pid"
rm -f -- "$lock_error_file"
lock_error_file=''
lock_rollback_column="$(psql_ci -d "$database" -Atc "SELECT count(*) FROM information_schema.columns WHERE table_name='campaigns' AND column_name='emergency_stopped_at';")"
if [[ "$lock_rollback_column" != '0' ]]; then
  echo "Lock-timeout failure left the marker column behind." >&2
  exit 1
fi

# Retry the exact reviewed SQL after PostgreSQL rolled back the failed attempt.
docker compose exec -T postgres psql -v ON_ERROR_STOP=1 -U truevine -d "$database" -f - \
  < "$migration" >/dev/null
trigger_count="$(psql_ci -d "$database" -Atc "SELECT count(*) FROM pg_trigger WHERE tgname='campaigns_emergency_stop_guard' AND NOT tgisinternal;")"
if [[ "$trigger_count" != '1' ]]; then
  echo "Retry did not install exactly one emergency-stop trigger." >&2
  exit 1
fi

psql_ci -d "$database" <<'SQL'
UPDATE "campaigns"
SET "status" = 'COMPLETED', "emergency_stopped_at" = now()
WHERE "status" = 'ACTIVE';
SQL

set +e
psql_ci -d "$database" -c "UPDATE campaigns SET status='ACTIVE';" >/dev/null 2>&1
legacy_restart=$?
set -e
if [[ "$legacy_restart" -eq 0 ]]; then
  echo "Emergency-stop trigger allowed a legacy restart." >&2
  exit 1
fi

set +e
psql_ci -d "$database" -c "DELETE FROM campaigns;" >/dev/null 2>&1
legacy_delete=$?
set -e
if [[ "$legacy_delete" -eq 0 ]]; then
  echo "Emergency-stop trigger allowed a legacy delete." >&2
  exit 1
fi

echo "RBAC-007 migration rehearsal passed: forced failure and lock timeout rolled back, exact retry succeeded, and legacy restart/delete were rejected."
