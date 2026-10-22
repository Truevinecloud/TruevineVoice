#!/usr/bin/env bash
set -Eeuo pipefail

if [[ "${GITHUB_ACTIONS:-}" != "true" ]]; then
  echo "Refusing migration rehearsal outside GitHub Actions." >&2
  exit 2
fi

database='w202_migration_rehearsal'
w2_migration='packages/database/prisma/migrations/20261022120000_contacts_groups_import_w2_02/migration.sql'
psql_ci() {
  docker compose exec -T postgres psql -X -v ON_ERROR_STOP=1 -U truevine "$@"
}
cleanup() {
  psql_ci -d postgres -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${database}' AND pid <> pg_backend_pid();" >/dev/null || true
  psql_ci -d postgres -c "DROP DATABASE IF EXISTS ${database} WITH (FORCE);" >/dev/null || true
}
trap cleanup EXIT

cleanup
psql_ci -d postgres -c "CREATE DATABASE ${database};" >/dev/null
mapfile -t migrations < <(find packages/database/prisma/migrations -mindepth 2 -maxdepth 2 -name migration.sql -print | sort)
if [[ "${migrations[-1]:-}" != "$w2_migration" ]]; then
  echo "Review this rehearsal when the migration history changes after W2-02." >&2
  exit 1
fi
for base_migration in "${migrations[@]:0:${#migrations[@]}-1}"; do
  psql_ci -d "$database" -f - < "$base_migration" >/dev/null
done

# Recreate representative pre-W2 production records after replaying the exact
# existing migration history, including the campaign contact and recipient FK.
psql_ci -d "$database" <<'SQL'
BEGIN;
INSERT INTO organizations(id,slug,name,updated_at) VALUES
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','w2a','W2-02 migration fixture',now()),
  ('99999999-9999-4999-8999-999999999999','w2b','W2-02 other tenant',now());
INSERT INTO users(id,email,password_hash,updated_at) VALUES
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','w2a@example.invalid','unusable',now()),
  ('88888888-8888-4888-8888-888888888888','w2b@example.invalid','unusable',now());
INSERT INTO memberships(organization_id,user_id,role,updated_at) VALUES
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','OWNER',now()),
  ('99999999-9999-4999-8999-999999999999','88888888-8888-4888-8888-888888888888','OWNER',now());
INSERT INTO campaigns(organization_id,id,name,status,created_by_user_id,updated_at)
VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee','Legacy campaign','DRAFT','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',now());
INSERT INTO contacts (organization_id,id,destination,label,updated_at)
VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','cccccccc-cccc-4ccc-8ccc-cccccccccccc','+256772000001','Legacy',now());
INSERT INTO campaign_recipients (organization_id,id,campaign_id,contact_id,destination)
VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','dddddddd-dddd-4ddd-8ddd-dddddddddddd','eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee','cccccccc-cccc-4ccc-8ccc-cccccccccccc','+256772000001');
COMMIT;
SQL

if [[ "$(head -n 3 "$w2_migration" | grep -c '^BEGIN;$')" -ne 1 ]] || [[ "$(tail -n 1 "$w2_migration" | grep -c '^COMMIT;$')" -ne 1 ]]; then
  echo "W2-02 migration must have one outer PostgreSQL transaction." >&2
  exit 1
fi
set +e
awk '$0 == "COMMIT;" { print "SELECT 1 / 0;" } { print }' "$w2_migration" |
  psql_ci -d "$database" >/dev/null 2>&1
forced_failure=$?
set -e
if [[ "$forced_failure" -eq 0 ]]; then
  echo "Forced W2-02 migration failure unexpectedly succeeded." >&2
  exit 1
fi
partial_tables="$(psql_ci -d "$database" -Atc "SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('contact_groups','contact_group_members','contact_imports','contact_import_batches');")"
partial_column="$(psql_ci -d "$database" -Atc "SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='contacts' AND column_name='phone_e164';")"
if [[ "$partial_tables" != '0' || "$partial_column" != '0' ]]; then
  echo "Failed W2-02 migration left schema changes behind." >&2
  exit 1
fi

psql_ci -d "$database" -f - < "$w2_migration" >/dev/null
preserved="$(psql_ci -d "$database" -Atc "SELECT count(*) FROM contacts c JOIN campaign_recipients r ON r.organization_id=c.organization_id AND r.contact_id=c.id WHERE c.id='cccccccc-cccc-4ccc-8ccc-cccccccccccc' AND r.id='dddddddd-dddd-4ddd-8ddd-dddddddddddd' AND r.destination='+256772000001' AND c.destination='+256772000001' AND c.label='Legacy' AND c.phone_e164 IS NULL AND c.voice_consent_at IS NULL AND c.suppressed_at IS NULL;")"
if [[ "$preserved" != '1' ]]; then
  echo "Migration changed or lost the legacy contact or campaign recipient." >&2
  exit 1
fi

psql_ci -d "$database" <<'SQL' >/dev/null
INSERT INTO contact_groups (organization_id,id,name,normalized_name,created_by_user_id,updated_at)
VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','ffffffff-ffff-4fff-8fff-ffffffffffff','Group','group','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',now());
INSERT INTO contacts (organization_id,id,destination,label,phone_e164,created_by_user_id,updated_at)
VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','11111111-1111-4111-8111-111111111111','+256772000002','New','+256772000002','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',now());
INSERT INTO contact_group_members (organization_id,group_id,contact_id)
VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','ffffffff-ffff-4fff-8fff-ffffffffffff','11111111-1111-4111-8111-111111111111');
INSERT INTO contact_groups (organization_id,id,name,normalized_name,created_by_user_id,updated_at)
VALUES ('99999999-9999-4999-8999-999999999999','77777777-7777-4777-8777-777777777777','Other','other','88888888-8888-4888-8888-888888888888',now());
SQL
set +e
psql_ci -d "$database" -c "INSERT INTO contacts (organization_id,id,destination,phone_e164,updated_at) VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','22222222-2222-4222-8222-222222222222','+256772000002','+256772000002',now());" >/dev/null 2>&1
duplicate=$?
psql_ci -d "$database" -c "INSERT INTO contact_group_members (organization_id,group_id,contact_id) VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','77777777-7777-4777-8777-777777777777','11111111-1111-4111-8111-111111111111');" >/dev/null 2>&1
cross_tenant=$?
set -e
if [[ "$duplicate" -eq 0 || "$cross_tenant" -eq 0 ]]; then
  echo "W2-02 uniqueness or tenant isolation constraint failed." >&2
  exit 1
fi

echo "W2-02 migration rehearsal passed: exact prior migrations, atomic failure rollback, legacy contact/recipient preservation, additive extension, tenant-scoped creators, and duplicate isolation."
