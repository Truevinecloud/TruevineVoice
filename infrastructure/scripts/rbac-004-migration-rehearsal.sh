#!/usr/bin/env bash
set -Eeuo pipefail

# This harness only targets a dedicated database inside the GitHub-hosted
# disposable Compose PostgreSQL. It never accepts a database name or host from
# the caller and refuses to run outside Actions.
if [[ "${GITHUB_ACTIONS:-}" != "true" ]]; then
  echo "Refusing migration rehearsal outside GitHub Actions." >&2
  exit 2
fi

database='rbac004_migration_rehearsal'
psql_ci() {
  docker compose exec -T postgres psql -v ON_ERROR_STOP=1 -U truevine "$@"
}
cleanup() {
  psql_ci -d postgres -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${database}' AND pid <> pg_backend_pid();" >/dev/null || true
  psql_ci -d postgres -c "DROP DATABASE IF EXISTS ${database} WITH (FORCE);" >/dev/null || true
}
trap cleanup EXIT

cleanup
psql_ci -d postgres -c "CREATE DATABASE ${database};" >/dev/null
psql_ci -d "$database" <<'SQL'
CREATE TABLE organizations (id UUID PRIMARY KEY);
CREATE TABLE users (id UUID PRIMARY KEY);
CREATE TABLE memberships (
  organization_id UUID NOT NULL REFERENCES organizations(id),
  user_id UUID NOT NULL REFERENCES users(id),
  PRIMARY KEY (organization_id, user_id)
);
INSERT INTO organizations VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'), ('cccccccc-cccc-4ccc-8ccc-cccccccccccc');
INSERT INTO users VALUES ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
INSERT INTO memberships VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
SQL

migration='packages/database/prisma/migrations/20261019160000_customer_billing_rbac_004/migration.sql'
if [[ "$(head -n 4 "$migration" | grep -c '^BEGIN;$')" -ne 1 ]] || [[ "$(tail -n 2 "$migration" | grep -c '^COMMIT;$')" -ne 1 ]]; then
  echo "RBAC-004 migration must have one outer PostgreSQL transaction." >&2
  exit 1
fi

set +e
awk '$0 == "COMMIT;" { print "SELECT 1 / 0;" } { print }' "$migration" |
  psql_ci -d "$database" >/dev/null 2>&1
forced_failure=$?
set -e
if [[ "$forced_failure" -eq 0 ]]; then
  echo "Forced failure unexpectedly succeeded." >&2
  exit 1
fi

partial_objects="$(psql_ci -d "$database" -Atc "SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('wallet_entries','top_up_requests','billing_profiles');")"
partial_function="$(psql_ci -d "$database" -Atc "SELECT count(*) FROM pg_proc WHERE proname='reject_billing_history_mutation';")"
if [[ "$partial_objects" != '0' || "$partial_function" != '0' ]]; then
  echo "Failed RBAC-004 attempt left schema objects behind." >&2
  exit 1
fi

docker compose exec -T postgres psql -v ON_ERROR_STOP=1 -U truevine -d "$database" -f - \
  < "$migration" >/dev/null
objects="$(psql_ci -d "$database" -Atc "SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('wallet_entries','top_up_requests','billing_profiles');")"
triggers="$(psql_ci -d "$database" -Atc "SELECT count(*) FROM pg_trigger WHERE tgname IN ('wallet_entries_append_only','wallet_entries_no_truncate','top_up_requests_append_only','top_up_requests_no_truncate') AND NOT tgisinternal;")"
if [[ "$objects" != '3' || "$triggers" != '4' ]]; then
  echo "Exact migration retry did not install the full billing schema." >&2
  exit 1
fi
wallet_org_fk="$(psql_ci -d "$database" -Atc "SELECT count(*) FROM pg_constraint WHERE conname='wallet_entries_organization_id_fkey';")"
topup_membership_fk="$(psql_ci -d "$database" -Atc "SELECT count(*) FROM pg_constraint WHERE conname='top_up_requests_organization_id_created_by_user_id_fkey';")"
if [[ "$wallet_org_fk" != '1' || "$topup_membership_fk" != '1' ]]; then
  echo "Retry did not retain organization and user foreign keys." >&2
  exit 1
fi

set +e
psql_ci -d "$database" -c "INSERT INTO top_up_requests (organization_id,id,idempotency_key,amount_minor,currency,created_by_user_id) VALUES ('cccccccc-cccc-4ccc-8ccc-cccccccccccc','dddddddd-dddd-4ddd-8ddd-dddddddddddd','eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',100,'UGX','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');" >/dev/null 2>&1
cross_tenant_writer=$?
set -e
if [[ "$cross_tenant_writer" -eq 0 ]]; then
  echo "A top-up request accepted a user from another organization." >&2
  exit 1
fi

echo "RBAC-004 migration rehearsal passed: forced failure rolled back every DDL object, exact retry succeeded, and tenant/user membership constraints rejected cross-organization writes."
