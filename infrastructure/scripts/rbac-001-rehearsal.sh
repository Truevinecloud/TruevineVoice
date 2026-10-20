#!/usr/bin/env bash
#
# Truevine Voice — RBAC-001 migration rehearsal on a DISPOSABLE PostgreSQL.
#
# WHAT THIS PROVES
# ----------------
# The e2e CI job already runs `prisma migrate deploy` against a throwaway
# database on every pull request. That covers the happy path on an EMPTY
# database. It does not cover the things that decide whether RBAC-001 is safe to
# apply to production:
#
#   1. Applying the migrations to a *populated* database without losing or
#      corrupting rows.
#   2. What the migrations do when the data they assume does not hold
#      (an OPERATOR membership, an ownerless organization, an OWNER invitation).
#   3. Whether a FAILED migration leaves partially applied schema behind. Three
#      of these files contain an explicit `BEGIN; ... COMMIT;` — in
#      `identity_rbac_001` it is in the MIDDLE of the file, with indexes, foreign
#      keys and a trigger after it. A failure after that COMMIT can leave the
#      database half-migrated. This script measures that instead of assuming it
#      cannot happen.
#
# SAFETY MODEL
# ------------
# This script never reads, mounts, connects to or otherwise touches production.
#
#   - It creates its own container, network and volume, every one of them named
#     from a fresh unique RUN_ID and labelled `truevine.rbac.rehearsal.run`.
#     Production is `truevine-postgres` / `truevine-postgres-data` with no such
#     label; the names cannot collide.
#   - PostgreSQL is started on a user-defined network and published on
#     127.0.0.1 only, so the host can reach it over TCP. It is never a
#     `--network none` container reached by host TCP, and it is unreachable from
#     any other host.
#   - Only synthetic UUIDs and example.test addresses are inserted. No
#     production data is ever copied in.
#   - Cleanup removes ONLY resources carrying this run's label, on every exit
#     path including a failure or an interrupt.
#
# Usage:
#   REHEARSAL_REQUIRED=1 bash infrastructure/scripts/rbac-001-rehearsal.sh
#
# Environment:
#   REHEARSAL_REQUIRED   "1" turns a skip (no Linux / no container runtime /
#                        no node_modules) into a hard failure. CI sets it.
#   REHEARSAL_RUNTIME    force a runtime name (docker or podman).
#
# Exit status is 0 only when every assertion passed. The FINDINGS section in the
# output records the measured transaction behaviour regardless of pass/fail.
#
set -uo pipefail

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
PG_IMAGE="postgres:18-alpine"
LABEL_KEY="truevine.rbac.rehearsal.run"
PG_USER="truevine"
DB_NAME="truevine_voice"
REAL_CONFIG="$REPO/packages/database/prisma.config.ts"
MIGRATIONS_SRC="$REPO/packages/database/prisma/migrations"

RUN_ID="${RANDOM}-$(date -u +%Y%m%dT%H%M%S)-$$"
NET="rbac-rehearsal-${RUN_ID}"
VOL="rbac-rehearsal-${RUN_ID}-pgdata"
CTR="rbac-rehearsal-${RUN_ID}-pg"
WORK="$REPO/.rbac-rehearsal/${RUN_ID}"
LOG_DIR="$WORK/logs"
FINDING_FILE=""

RUNTIME="${REHEARSAL_RUNTIME:-}"
PRISMA=""
PORT=""
DB_URL=""
FAILURES=0

# ---------------------------------------------------------------- output
say()   { printf '\n=== %s ===\n' "$*"; }
info()  { printf '  %s\n' "$*"; }
pass()  { printf '  OK       %s\n' "$*"; }
fail()  { printf '  FAIL     %s\n' "$*"; FAILURES=$((FAILURES + 1)); }
die()   { printf '  FATAL    %s\n' "$*" >&2; exit 2; }
finding() { printf '  FINDING  %s\n' "$*"; if [ -n "$FINDING_FILE" ]; then printf '%s\n' "$*" >> "$FINDING_FILE"; fi; }

# ---------------------------------------------------------------- environment
detect_runtime() {
  if [ -n "$RUNTIME" ]; then
    command -v "$RUNTIME" >/dev/null 2>&1 || { RUNTIME=""; return; }
    return
  fi
  if command -v docker >/dev/null 2>&1; then RUNTIME=docker
  elif command -v podman >/dev/null 2>&1; then RUNTIME=podman
  else RUNTIME=""
  fi
}

guard_environment() {
  if [ "$(uname -s)" != "Linux" ]; then
    if [ "${REHEARSAL_REQUIRED:-0}" = "1" ]; then
      printf 'FATAL: REHEARSAL_REQUIRED=1 but this host is not Linux.\n' >&2
      exit 1
    fi
    printf 'SKIP: RBAC-001 rehearsal needs a Linux host with a container runtime.\n'
    exit 0
  fi
  detect_runtime
  if [ -z "$RUNTIME" ]; then
    if [ "${REHEARSAL_REQUIRED:-0}" = "1" ]; then
      printf 'FATAL: REHEARSAL_REQUIRED=1 but neither docker nor podman is on PATH.\n' >&2
      exit 1
    fi
    printf 'SKIP: no docker or podman on PATH; RBAC-001 rehearsal was not run.\n'
    exit 0
  fi
  if ! command -v node >/dev/null 2>&1 || [ ! -d "$REPO/node_modules" ]; then
    if [ "${REHEARSAL_REQUIRED:-0}" = "1" ]; then
      printf 'FATAL: REHEARSAL_REQUIRED=1 but node/npm dependencies are missing; run `npm ci` first.\n' >&2
      exit 1
    fi
    printf 'SKIP: node_modules is absent (run `npm ci`); RBAC-001 rehearsal was not run.\n'
    exit 0
  fi
  resolve_prisma
  if [ -z "$PRISMA" ]; then
    printf 'FATAL: the local prisma CLI was not found under node_modules; run `npm ci`.\n' >&2
    exit 1
  fi
}

resolve_prisma() {
  # Prefer the workspace-hoisted binary; fall back to the package-local one.
  if [ -x "$REPO/node_modules/.bin/prisma" ]; then
    PRISMA="$REPO/node_modules/.bin/prisma"
  elif [ -x "$REPO/packages/database/node_modules/.bin/prisma" ]; then
    PRISMA="$REPO/packages/database/node_modules/.bin/prisma"
  else
    PRISMA=""
  fi
}

# ---------------------------------------------------------------- cleanup
cleanup() {
  [ -n "$RUNTIME" ] || return 0
  local lbl
  if [ -n "$CTR" ] && $RUNTIME inspect "$CTR" >/dev/null 2>&1; then
    lbl="$($RUNTIME inspect --format "{{index .Config.Labels \"${LABEL_KEY}\"}}" "$CTR" 2>/dev/null || true)"
    if [ "$lbl" = "$RUN_ID" ]; then
      $RUNTIME rm -fv "$CTR" >/dev/null 2>&1 || true
    else
      printf '  WARN     not removing container %s: label %q is not this run\n' "$CTR" "$lbl" >&2
    fi
  fi
  if [ -n "$VOL" ] && $RUNTIME volume inspect "$VOL" >/dev/null 2>&1; then
    lbl="$($RUNTIME volume inspect --format "{{index .Labels \"${LABEL_KEY}\"}}" "$VOL" 2>/dev/null || true)"
    [ "$lbl" = "$RUN_ID" ] && $RUNTIME volume rm "$VOL" >/dev/null 2>&1 || true
  fi
  if [ -n "$NET" ] && $RUNTIME network inspect "$NET" >/dev/null 2>&1; then
    lbl="$($RUNTIME network inspect --format "{{index .Labels \"${LABEL_KEY}\"}}" "$NET" 2>/dev/null || true)"
    [ "$lbl" = "$RUN_ID" ] && $RUNTIME network rm "$NET" >/dev/null 2>&1 || true
  fi
}

on_exit() {
  local rc=$?
  cleanup
  [ -n "$WORK" ] && rm -rf "$WORK"
  return $rc
}
trap on_exit EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

# ---------------------------------------------------------------- containers
start_pg() {
  $RUNTIME network create --label "${LABEL_KEY}=${RUN_ID}" "$NET" >/dev/null \
    || die "could not create network ${NET}"
  $RUNTIME volume create --label "${LABEL_KEY}=${RUN_ID}" "$VOL" >/dev/null \
    || die "could not create volume ${VOL}"
  # Loopback-only publish. This is the one deliberate difference from
  # db-verify.sh, which uses `--network none` because it always `docker exec`s;
  # the Prisma CLI runs on this host and must reach PostgreSQL over TCP.
  $RUNTIME run -d --name "$CTR" --network "$NET" \
    --mount "type=volume,src=${VOL},dst=/var/lib/postgresql" \
    -p 127.0.0.1::5432 \
    --label "${LABEL_KEY}=${RUN_ID}" \
    -e POSTGRES_USER="$PG_USER" \
    -e POSTGRES_DB="$DB_NAME" \
    -e POSTGRES_HOST_AUTH_METHOD=trust \
    "$PG_IMAGE" >/dev/null || die "could not start ${PG_IMAGE}"

  PORT="$($RUNTIME port "$CTR" 5432/tcp | head -n 1 | sed 's/.*://')"
  [ -n "$PORT" ] || die "could not determine the published PostgreSQL port"

  local i
  for i in $(seq 1 90); do
    # -h 127.0.0.1 forces a TCP check. During initdb the entrypoint runs a
    # temporary server on a unix socket only, so a socket pg_isready reports
    # ready too early; the TCP check does not.
    if $RUNTIME exec "$CTR" pg_isready -h 127.0.0.1 -p 5432 -U "$PG_USER" -d "$DB_NAME" >/dev/null 2>&1; then
      break
    fi
    sleep 1
  done
  $RUNTIME exec "$CTR" psql -h 127.0.0.1 -p 5432 -U "$PG_USER" -d "$DB_NAME" -tAc 'SELECT 1' >/dev/null 2>&1 \
    || die "PostgreSQL never accepted a TCP query"
}

reset_db() {
  $RUNTIME exec "$CTR" psql -v ON_ERROR_STOP=1 -U "$PG_USER" -d postgres \
    -c "DROP DATABASE IF EXISTS \"${DB_NAME}\" WITH (FORCE);" >/dev/null 2>&1 || true
  $RUNTIME exec "$CTR" psql -v ON_ERROR_STOP=1 -U "$PG_USER" -d postgres \
    -c "CREATE DATABASE \"${DB_NAME}\";" >/dev/null 2>&1 \
    || die "could not recreate the rehearsal database"
}

# ---------------------------------------------------------------- psql / prisma
psql_q() {
  # psql_q <sql>  -> single value, no header, trailing CR stripped
  $RUNTIME exec -i "$CTR" psql -v ON_ERROR_STOP=1 -U "$PG_USER" -d "$DB_NAME" -tAc "$1" 2>/dev/null | tr -d '\r'
}

psql_f() {
  # psql_f <sql-file-on-stdin; prints errors>
  $RUNTIME exec -i "$CTR" psql -v ON_ERROR_STOP=1 -U "$PG_USER" -d "$DB_NAME" -f -
}

# ---------------------------------------------------------------- work tree
prepare_work() {
  mkdir -p "$LOG_DIR"
  FINDING_FILE="$WORK/findings.txt"
  : > "$FINDING_FILE"
  cp "$REAL_CONFIG" "$WORK/prisma.config.ts"
  mkdir -p "$WORK/prisma"
  cp "$REPO/packages/database/prisma/schema.prisma" "$WORK/prisma/schema.prisma"
}

prepare_migrations_dir() {
  rm -rf "$WORK/prisma/migrations"
  mkdir -p "$WORK/prisma/migrations"
  cp "$MIGRATIONS_SRC/migration_lock.toml" "$WORK/prisma/migrations/migration_lock.toml"
}

add_migration() {
  # add_migration <dir-name> [custom-sql-file]
  local name=$1 src="${2:-$MIGRATIONS_SRC/$1/migration.sql}"
  mkdir -p "$WORK/prisma/migrations/$name"
  cp "$src" "$WORK/prisma/migrations/$name/migration.sql"
}

write_probe_migration() {
  # write_probe_migration <dir-name>  (SQL on stdin)
  local name=$1
  mkdir -p "$WORK/prisma/migrations/$name"
  cat > "$WORK/prisma/migrations/$name/migration.sql"
}

append_line() {
  printf '%s\n' "$2" >> "$WORK/prisma/migrations/$1/migration.sql"
}

add_all_real_migrations() {
  # Copies every real migration directory. A later deploy must still contain the
  # migrations an earlier deploy already applied, or Prisma reports an applied
  # migration as missing from the directory; the full prefix is what production
  # always presents.
  local d name
  for d in "$MIGRATIONS_SRC"/*/; do
    [ -d "$d" ] || continue
    name="$(basename "$d")"
    add_migration "$name"
  done
}

run_deploy() {
  # run_deploy <config-path> <logfile> ; returns prisma's exit status
  local cfg=$1 log=$2
  ( cd "$REPO" && DATABASE_URL="$DB_URL" "$PRISMA" migrate deploy --config "$cfg" ) >"$log" 2>&1
  return $?
}

# ---------------------------------------------------------------- assertions
assert_rc() {
  local d=$1 want=$2 got=$3
  [ "$got" = "$want" ] && pass "$d (exit $got)" || fail "$d (exit $got, want $want)"
}

assert_error_contains() {
  # The specific message is preferred, but a failing multi-statement migration
  # can surface a later "current transaction is aborted" cascade instead of the
  # original error, depending on how the runner batches statements. This fails
  # only when the log reports no error at all, and records what was seen.
  local d=$1 needle=$2 file=$3
  if grep -qF -- "$needle" "$file"; then
    pass "$d"
  elif grep -qiE 'error|aborted|refused|exception|violat' "$file"; then
    pass "$d (an error was reported; the exact text was not surfaced)"
    finding "$d: log did not contain '$needle'. Observed: $(tr '\n' ' ' < "$file" | tail -c 400)"
  else
    fail "$d (no error was reported at all)"
    tail -n 15 "$file" | sed 's/^/           /'
  fi
}

assert_sql() {
  local d=$1 want=$2 sql=$3 got
  got="$(psql_q "$sql")"
  [ "$got" = "$want" ] && pass "$d ($got)" || fail "$d (got '$got', want '$want')"
}

assert_present() { assert_sql "$1" "1" "$2"; }

# ---------------------------------------------------------------- scenarios
scenario_fresh_full_deploy() {
  say "S1  fresh, empty database — deploy every real migration with the real config"
  reset_db
  local log="$LOG_DIR/s1.log"
  local migration_count
  migration_count="$(find "$MIGRATIONS_SRC" -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d '[:space:]')"
  run_deploy "$REAL_CONFIG" "$log"
  assert_rc "S1  migrate deploy succeeds on an empty database" 0 "$?"

  assert_sql "S1  ledger records all ${migration_count} cleanly applied migrations" "$migration_count" \
    "SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL;"
  assert_sql "S1  MembershipRole is the post-swap label set" \
    "OWNER,ADMIN,CAMPAIGN_MANAGER,BILLING,VIEWER" \
    "SELECT string_agg(enumlabel,',' ORDER BY enumsortorder) FROM pg_enum e JOIN pg_type t ON t.oid=e.enumtypid WHERE t.typname='MembershipRole';"
  assert_present "S1  citext extension is installed" \
    "SELECT count(*) FROM pg_extension WHERE extname='citext';"
  assert_sql "S1  users.email is CITEXT" "citext" \
    "SELECT udt_name FROM information_schema.columns WHERE table_schema='public' AND table_name='users' AND column_name='email';"

  local t
  for t in users sessions password_reset_tokens terms_acceptances \
           platform_role_assignments invitations security_audit_events identity_audit_events; do
    assert_present "S1  table ${t} exists" \
      "SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_name='${t}';"
  done
  assert_present "S1  index memberships_single_owner exists" \
    "SELECT count(*) FROM pg_indexes WHERE schemaname='public' AND indexname='memberships_single_owner';"
  assert_present "S1  column organizations.suspended_at exists" \
    "SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='organizations' AND column_name='suspended_at';"

  local f
  for f in security_audit_events_append_only enforce_exactly_one_owner \
           enforce_invitation_identity enforce_invitation_origin; do
    assert_present "S1  function ${f} exists" \
      "SELECT count(*) FROM pg_proc WHERE proname='${f}';"
  done
  local g
  for g in security_audit_events_no_update_delete identity_audit_events_no_update_delete \
           memberships_exactly_one_owner organizations_exactly_one_owner \
           invitations_identity_binding invitations_origin_binding; do
    assert_present "S1  trigger ${g} exists" \
      "SELECT count(*) FROM pg_trigger WHERE tgname='${g}' AND NOT tgisinternal;"
  done
}

scenario_populated_valid() {
  say "S2  populated, valid database — apply migrations 1..4, seed synthetic rows, then the full migration set"
  reset_db
  prepare_migrations_dir
  add_migration 20261014042915_tenancy_core
  add_migration 20261016130500_identity_rbac_001
  add_migration 20261016141500_identity_audit_events
  add_migration 20261016142500_identity_audit_fk_restrict
  local log="$LOG_DIR/s2a.log"
  run_deploy "$WORK/prisma.config.ts" "$log"
  assert_rc "S2  partial deploy (1..4) succeeds" 0 "$?"

  psql_f >"$LOG_DIR/s2seed.log" 2>&1 <<'SQL'
INSERT INTO users (id, email, password_hash, updated_at) VALUES
  ('11111111-1111-1111-1111-111111111111', 'owner@example.test', 'x', now()),
  ('22222222-2222-2222-2222-222222222222', 'admin@example.test', 'x', now());
INSERT INTO organizations (id, slug, name, updated_at) VALUES
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'org-one', 'Org One', now()),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'org-two', 'Org Two', now());
INSERT INTO memberships (organization_id, user_id, role, updated_at) VALUES
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111', 'OWNER', now()),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '22222222-2222-2222-2222-222222222222', 'ADMIN', now()),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '22222222-2222-2222-2222-222222222222', 'OWNER', now());
INSERT INTO invitations (organization_id, id, email, role, token_hash, invited_by_user_id, expires_at)
VALUES ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        'cccccccc-cccc-cccc-cccc-cccccccccccc',
        'invitee@example.test', 'ADMIN', 'deadbeef',
        '11111111-1111-1111-1111-111111111111', now() + interval '7 days');
SQL
  assert_rc "S2  synthetic seed succeeds" 0 "$?"

  prepare_migrations_dir
  add_all_real_migrations
  local log2="$LOG_DIR/s2b.log"
  run_deploy "$WORK/prisma.config.ts" "$log2"
  assert_rc "S2  deploy of remaining migrations onto the populated database succeeds" 0 "$?"

  assert_sql "S2  organizations preserved" "2" "SELECT count(*) FROM organizations;"
  assert_sql "S2  memberships preserved"   "3" "SELECT count(*) FROM memberships;"
  assert_sql "S2  users preserved"         "2" "SELECT count(*) FROM users;"
  assert_sql "S2  invitations preserved"   "1" "SELECT count(*) FROM invitations;"
  assert_present "S2  organizations.suspended_at added" \
    "SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='organizations' AND column_name='suspended_at';"
  assert_present "S2  memberships_single_owner index added" \
    "SELECT count(*) FROM pg_indexes WHERE schemaname='public' AND indexname='memberships_single_owner';"
  local migration_count
  migration_count="$(find "$MIGRATIONS_SRC" -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d '[:space:]')"
  assert_sql "S2  ledger records all ${migration_count} cleanly applied migrations" "$migration_count" \
    "SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL;"
}

scenario_adversarial_operator() {
  say "S3  adversarial — a pre-existing OPERATOR membership (the enum value has no successor)"
  reset_db
  prepare_migrations_dir
  add_migration 20261014042915_tenancy_core
  run_deploy "$WORK/prisma.config.ts" "$LOG_DIR/s3a.log"
  assert_rc "S3  tenancy_core applies alone" 0 "$?"

  psql_f >"$LOG_DIR/s3seed.log" 2>&1 <<'SQL'
INSERT INTO organizations (id, slug, name, updated_at)
VALUES ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'legacy', 'Legacy Org', now());
INSERT INTO memberships (organization_id, user_id, role, updated_at)
VALUES ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '99999999-9999-9999-9999-999999999999', 'OPERATOR', now());
SQL
  assert_rc "S3  seed of an OPERATOR membership succeeds on the old enum" 0 "$?"

  prepare_migrations_dir
  add_all_real_migrations
  local log="$LOG_DIR/s3b.log"
  run_deploy "$WORK/prisma.config.ts" "$log"
  assert_rc "S3  identity_rbac_001 FAILS on the OPERATOR membership" 1 "$?"
  assert_error_contains "S3  the failure names the OPERATOR value" "OPERATOR" "$log"
  assert_sql "S3  ledger records identity_rbac_001 as failed" "1" \
    "SELECT count(*) FROM _prisma_migrations WHERE migration_name='20261016130500_identity_rbac_001' AND finished_at IS NULL;"
  assert_sql "S3  the enum swap did NOT apply (old labels retained)" \
    "OWNER,ADMIN,OPERATOR,VIEWER" \
    "SELECT string_agg(enumlabel,',' ORDER BY enumsortorder) FROM pg_enum e JOIN pg_type t ON t.oid=e.enumtypid WHERE t.typname='MembershipRole';"

  local partial enum_now
  partial="$(psql_q "SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('users','invitations','security_audit_events');")"
  enum_now="$(psql_q "SELECT string_agg(enumlabel,',' ORDER BY enumsortorder) FROM pg_enum e JOIN pg_type t ON t.oid=e.enumtypid WHERE t.typname='MembershipRole';")"
  finding "S3  after a failed identity_rbac_001: objects created before the mid-file COMMIT = ${partial}/3 (users, invitations, security_audit_events)."
  finding "S3  MembershipRole after the failure: ${enum_now}."
}

scenario_adversarial_ownerless() {
  say "S4  adversarial — an organization with no OWNER (security_atomicity must refuse)"
  reset_db
  prepare_migrations_dir
  local m
  for m in 20261014042915_tenancy_core 20261016130500_identity_rbac_001 \
           20261016141500_identity_audit_events 20261016142500_identity_audit_fk_restrict; do
    add_migration "$m"
  done
  run_deploy "$WORK/prisma.config.ts" "$LOG_DIR/s4a.log"
  assert_rc "S4  deploy of 1..4 succeeds" 0 "$?"

  psql_f >"$LOG_DIR/s4seed.log" 2>&1 <<'SQL'
INSERT INTO users (id, email, password_hash, updated_at)
VALUES ('22222222-2222-2222-2222-222222222222', 'viewer@example.test', 'x', now());
INSERT INTO organizations (id, slug, name, updated_at)
VALUES ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'ownerless', 'Ownerless Org', now());
INSERT INTO memberships (organization_id, user_id, role, updated_at)
VALUES ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '22222222-2222-2222-2222-222222222222', 'VIEWER', now());
SQL
  assert_rc "S4  seed of an ownerless organization succeeds" 0 "$?"

  prepare_migrations_dir
  add_all_real_migrations
  local log="$LOG_DIR/s4b.log"
  run_deploy "$WORK/prisma.config.ts" "$log"
  assert_rc "S4  security_atomicity FAILS on the ownerless organization" 1 "$?"
  assert_error_contains "S4  the failure is the owner-count refusal" "exactly one OWNER" "$log"
  assert_sql "S4  memberships_single_owner index was NOT created" "0" \
    "SELECT count(*) FROM pg_indexes WHERE schemaname='public' AND indexname='memberships_single_owner';"

  local susp
  susp="$(psql_q "SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='organizations' AND column_name='suspended_at';")"
  finding "S4  after the S4 failure, organizations.suspended_at present = ${susp} (migration 5 commits before migration 6 runs; earlier migrations legitimately persist)."
}

scenario_adversarial_invitation() {
  say "S5  adversarial — an OWNER invitation (security_atomicity must refuse)"
  reset_db
  prepare_migrations_dir
  local m
  for m in 20261014042915_tenancy_core 20261016130500_identity_rbac_001 \
           20261016141500_identity_audit_events 20261016142500_identity_audit_fk_restrict; do
    add_migration "$m"
  done
  run_deploy "$WORK/prisma.config.ts" "$LOG_DIR/s5a.log"
  assert_rc "S5  deploy of 1..4 succeeds" 0 "$?"

  psql_f >"$LOG_DIR/s5seed.log" 2>&1 <<'SQL'
INSERT INTO users (id, email, password_hash, updated_at) VALUES
  ('11111111-1111-1111-1111-111111111111', 'owner@example.test', 'x', now()),
  ('22222222-2222-2222-2222-222222222222', 'invitee@example.test', 'x', now());
INSERT INTO organizations (id, slug, name, updated_at)
VALUES ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'org-one', 'Org One', now());
INSERT INTO memberships (organization_id, user_id, role, updated_at)
VALUES ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111', 'OWNER', now());
-- An OWNER invitation: forbidden by security_atomicity's DO block.
INSERT INTO invitations (organization_id, id, email, role, token_hash, invited_by_user_id, expires_at)
VALUES ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        'cccccccc-cccc-cccc-cccc-cccccccccccc',
        'someone@example.test', 'OWNER', 'deadbeef',
        '11111111-1111-1111-1111-111111111111', now() + interval '7 days');
SQL
  assert_rc "S5  seed of an OWNER invitation succeeds before the constraint exists" 0 "$?"

  prepare_migrations_dir
  add_all_real_migrations
  local log="$LOG_DIR/s5b.log"
  run_deploy "$WORK/prisma.config.ts" "$log"
  assert_rc "S5  security_atomicity FAILS on the OWNER invitation" 1 "$?"
  assert_error_contains "S5  the failure is the invitation refusal" "inconsistent invitation identity" "$log"
  assert_sql "S5  invitation_acceptance_pair constraint was NOT added" "0" \
    "SELECT count(*) FROM pg_constraint WHERE conname='invitation_acceptance_pair';"
}

scenario_probe_multi_statement() {
  say "S6  probe — does a failing MULTI-statement migration roll back? (Prisma transaction wrapping)"
  reset_db
  prepare_migrations_dir
  write_probe_migration 20269999990000_probe_multi <<'SQL'
CREATE TABLE probe_multi_marker(id integer);
SELECT 1/0;
SQL
  local log="$LOG_DIR/s6.log"
  run_deploy "$WORK/prisma.config.ts" "$log"
  assert_rc "S6  the probe migration fails" 1 "$?"
  local marker
  marker="$(psql_q "SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_name='probe_multi_marker';")"
  if [ "$marker" = "1" ]; then
    finding "S6  a failed 2-statement migration LEFT probe_multi_marker behind => Prisma did NOT roll it back."
  else
    finding "S6  a failed 2-statement migration left NOTHING behind => Prisma wrapped it in a transaction and rolled it back."
  fi
}

scenario_probe_failure_before_commit() {
  say "S7  probe — failure INSIDE an explicit BEGIN/COMMIT"
  reset_db
  prepare_migrations_dir
  write_probe_migration 20269999990001_probe_before_commit <<'SQL'
BEGIN;
CREATE TABLE probe_uncommitted(id integer);
SELECT 1/0;
COMMIT;
SQL
  local log="$LOG_DIR/s7.log"
  run_deploy "$WORK/prisma.config.ts" "$log"
  assert_rc "S7  the probe migration fails" 1 "$?"
  local marker
  marker="$(psql_q "SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_name='probe_uncommitted';")"
  assert_sql "S7  the aborted transaction left no table (expected)" "0" \
    "SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_name='probe_uncommitted';"
  finding "S7  failure inside an explicit BEGIN/COMMIT left probe_uncommitted present=${marker} (0 = the aborted transaction rolled back cleanly)."
}

scenario_real_late_failure() {
  say "S8  decisive — a late failure in the REAL identity_rbac_001 (after its mid-file COMMIT)"
  reset_db
  prepare_migrations_dir
  add_migration 20261014042915_tenancy_core
  add_migration 20261016130500_identity_rbac_001
  # Simulate a statement after the real file's COMMIT failing (e.g. a foreign key
  # over existing rows). This is the case that decides whether these files can
  # leave the database half-migrated.
  append_line 20261016130500_identity_rbac_001 ""
  append_line 20261016130500_identity_rbac_001 "-- rehearsal-injected failure, after the file's COMMIT"
  append_line 20261016130500_identity_rbac_001 "SELECT 1/0;"
  local log="$LOG_DIR/s8.log"
  run_deploy "$WORK/prisma.config.ts" "$log"
  assert_rc "S8  the tampered identity_rbac_001 fails" 1 "$?"
  assert_sql "S8  ledger records identity_rbac_001 as failed" "1" \
    "SELECT count(*) FROM _prisma_migrations WHERE migration_name='20261016130500_identity_rbac_001' AND finished_at IS NULL;"

  local enum_now tables
  enum_now="$(psql_q "SELECT string_agg(enumlabel,',' ORDER BY enumsortorder) FROM pg_enum e JOIN pg_type t ON t.oid=e.enumtypid WHERE t.typname='MembershipRole';")"
  tables="$(psql_q "SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('users','invitations','security_audit_events');")"
  finding "S8  after a LATE failure in the real identity_rbac_001: MembershipRole = ${enum_now}; RBAC tables present = ${tables}/3."
  if [ "$tables" = "3" ]; then
    finding "S8  CONFIRMED: a late failure in identity_rbac_001 leaves the enum swapped and tables created => partial application is possible. Recovery must use 'prisma migrate resolve', not a blind re-run."
  else
    finding "S8  a late failure in identity_rbac_001 left no RBAC tables (unexpected given the mid-file COMMIT; record this result)."
  fi
}

# ---------------------------------------------------------------- main
print_findings() {
  say "FINDINGS (measured on this disposable instance)"
  if [ -s "$FINDING_FILE" ]; then
    sed 's/^/  /' "$FINDING_FILE"
  else
    info "(none recorded)"
  fi
}

main() {
  guard_environment
  prepare_work
  say "disposable PostgreSQL"
  start_pg
  DB_URL="postgresql://${PG_USER}@127.0.0.1:${PORT}/${DB_NAME}?schema=public"
  info "runtime   : $RUNTIME"
  info "container : $CTR   (published on 127.0.0.1:${PORT} only)"
  info "volume    : $VOL"
  info "image     : $PG_IMAGE"
  info "database  : $DB_NAME as role $PG_USER (bootstrap superuser; production role is not)"
  info "no production data, container or volume is read, mounted or referenced"

  scenario_fresh_full_deploy
  scenario_populated_valid
  scenario_adversarial_operator
  scenario_adversarial_ownerless
  scenario_adversarial_invitation
  scenario_probe_multi_statement
  scenario_probe_failure_before_commit
  scenario_real_late_failure

  print_findings

  if [ "$FAILURES" -ne 0 ]; then
    printf '\nRESULT: FAIL (%d assertion(s) failed)\n' "$FAILURES"
    exit 1
  fi
  printf '\nRESULT: PASS\n'
}

main "$@"
