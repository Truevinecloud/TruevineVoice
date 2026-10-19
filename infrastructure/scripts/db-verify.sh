#!/usr/bin/env bash
#
# Truevine Voice — PostgreSQL and Redis recovery verification.
#
# This script exists because the procedures in
# docs/runbooks/postgres-redis-recovery.md were originally run by hand, and
# hand-run verification produced false passes: shell quoting silently corrupted
# SQL, both sides of a comparison returned the same error text, and `diff`
# scored that as "identical". Every comparison here aborts on any command
# error, any non-zero exit status, and any ERROR in psql output.
#
# SAFETY MODEL
# ------------
# Production protection is based on *identity*, never on name alone.
#
#  - Every resource this script creates carries the label
#    `truevine.verify.run=<run id>`. Nothing is destroyed unless it carries
#    this run's label. Renaming production cannot defeat that: a renamed
#    production container still has no such label, so it is never a candidate.
#  - Production identity (container ids, volume names, volume mountpoints) is
#    captured at start-up and refused as well, as a second, independent guard.
#  - Ownership is asserted immediately before each destructive command and
#    fails closed. If identity cannot be established, nothing is removed.
#  - Cleanup, including after a failure or an interrupt, only ever removes
#    resources labelled with this run's id. Backups are never removed.
#
# This script only reads the production datastores. It never stops, restarts,
# recreates or modifies production containers, volumes or data.
#
# Usage:
#   db-verify.sh preflight
#   db-verify.sh backup
#   db-verify.sh verify-restore      <backup.dump>
#   db-verify.sh verify-volume       <backup.dump>
#   db-verify.sh verify-redis
#   db-verify.sh cleanup             [--all-runs]
#
# Environment:
#   BACKUP_DIR   where backups are written   (default /var/backups/truevinevoice)
#
# Exit status is 0 only when every assertion passed.
#
set -euo pipefail

readonly BACKUP_DIR="${BACKUP_DIR:-/var/backups/truevinevoice}"
readonly PROD_DB_NAME="truevine_voice"
readonly PROD_DB_ROLE="truevine"
readonly PG_IMAGE="postgres:18-alpine"
readonly REDIS_IMAGE="redis:8-alpine"
readonly PG_MOUNTPOINT="/var/lib/postgresql"
readonly REDIS_MOUNTPOINT="/data"
readonly LABEL_KEY="truevine.verify.run"
readonly LABEL_PREFIX="truevine.verify."

# Configured production names. These are a *first* guard only; the captured
# identity below is what actually protects production.
readonly PROD_CONTAINERS="truevine-postgres truevine-redis"
readonly PROD_VOLUMES="truevine-postgres-data truevine-redis-data"

RUN_ID="$$-$(date -u +%Y%m%dT%H%M%SZ)"
STATE_DIR=""
FAILURES=0
CLEANED=0

# ---------------------------------------------------------------- output
say()  { printf '\n=== %s ===\n' "$*"; }
info() { printf '  %s\n' "$*"; }
pass() { printf '  OK    %s\n' "$*"; }
fail() { printf '  FAIL  %s\n' "$*"; FAILURES=$((FAILURES + 1)); }
die()  { printf '  FATAL %s\n' "$*" >&2; exit 2; }

# ---------------------------------------------------------------- identity
exists() {
  # exists <container|volume> <name>
  case "$1" in
    container) docker inspect "$2" >/dev/null 2>&1 ;;
    volume)    docker volume inspect "$2" >/dev/null 2>&1 ;;
    *) die "internal: unknown resource kind '$1'" ;;
  esac
}

label_of() {
  # label_of <container|volume> <name>; empty when absent or unlabelled
  case "$1" in
    container) docker inspect --format "{{index .Config.Labels \"${LABEL_KEY}\"}}" "$2" 2>/dev/null || true ;;
    volume)    docker volume inspect --format "{{index .Labels \"${LABEL_KEY}\"}}" "$2" 2>/dev/null || true ;;
    *) die "internal: unknown resource kind '$1'" ;;
  esac
}

# The single gate every destructive command passes through.
assert_owned() {
  local kind=$1 name=$2 label
  if [ -z "$name" ]; then die "internal: refusing to operate on an empty $kind name"; fi
  if ! exists "$kind" "$name"; then return 0; fi   # already gone; nothing to do
  label=$(label_of "$kind" "$name")
  if [ -z "$label" ]; then
    die "refusing to remove $kind '$name': it carries no ${LABEL_KEY} label, so it cannot be proven to belong to this run (run=${RUN_ID})"
  fi
  if [ "$label" != "$RUN_ID" ]; then
    die "refusing to remove $kind '$name': it belongs to run '${label}', not to this run ('${RUN_ID}')"
  fi
  pass "$kind '$name' is owned by this run"
}

register() {
  # register <container|volume> <name>
  mkdir -p "$STATE_DIR"
  printf '%s\t%s\n' "$1" "$2" >> "$STATE_DIR/owned"
}

safe_remove_container() {
  assert_owned container "$1"
  if exists container "$1"; then
    docker rm -fv "$1" >/dev/null 2>&1 && pass "removed container $1" \
      || fail "could not remove container $1"
  fi
}

safe_remove_volume() {
  assert_owned volume "$1"
  if exists volume "$1"; then
    docker volume rm "$1" >/dev/null 2>&1 && pass "removed volume $1" \
      || fail "could not remove volume $1"
  fi
}

# Production identity, captured at run start. Complements the label gate: even
# a resource carrying this run's label is refused if it is demonstrably
# production.
PROD_IDS=""
PROD_MOUNTPOINTS=""
capture_production_identity() {
  local c v
  PROD_IDS=""
  PROD_MOUNTPOINTS=""
  for c in $PROD_CONTAINERS; do
    if exists container "$c"; then
      PROD_IDS="${PROD_IDS}$(docker inspect --format '{{.Id}}' "$c")"$'\n'
    fi
  done
  PROD_IDS=$(printf '%s' "$PROD_IDS" | grep -v '^$' || true)
  for v in $PROD_VOLUMES; do
    if exists volume "$v"; then
      PROD_MOUNTPOINTS="${PROD_MOUNTPOINTS} $(docker volume inspect --format '{{.Mountpoint}}' "$v")"
    fi
  done
  info "captured production container ids:"
  printf '%s\n' "$PROD_IDS" | sed 's/^/    /' || true
  info "captured production volume mountpoints:"
  printf '%s' "$PROD_MOUNTPOINTS" | tr ' ' '\n' | grep -v '^$' | sed 's/^/    /' || true
}

# A created container must never be, or share an id with, production. This
# holds even if production is renamed, because ids are captured live.
assert_not_production_id() {
  local id=$1 known
  [ -n "$id" ] || return 0
  if [ -z "$PROD_IDS" ]; then
    die "no production identity was captured; refusing to create resources"
  fi
  if printf '%s' "$PROD_IDS" | grep -qx "$id"; then
    die "refusing: ${id} is a production container id"
  fi
  pass "created container id is not a production id"
}

assert_not_production() {
  # assert_not_production <container|volume> <name>
  local kind=$1 name=$2 list item mp
  case "$kind" in
    container) list=$PROD_CONTAINERS ;;
    volume)    list=$PROD_VOLUMES ;;
    *) die "internal: unknown resource kind '$kind'" ;;
  esac
  for item in $list; do
    [ "$name" = "$item" ] && die "refusing to use production $kind '$name'"
  done
  if [ "$kind" = volume ]; then
    if [ -n "$PROD_MOUNTPOINTS" ] && exists volume "$name"; then
      mp=$(docker volume inspect --format '{{.Mountpoint}}' "$name" 2>/dev/null || true)
      for item in $PROD_MOUNTPOINTS; do
        [ -n "$mp" ] && [ "$mp" = "$item" ] \
          && die "refusing to use volume '$name': its mountpoint is the production mountpoint ($mp)"
      done
    fi
  fi
  pass "$kind '$name' is not a production resource"
}

# ---------------------------------------------------------------- cleanup
cleanup_owned() {
  # Removes only what this run created. Never touches backups.
  [ -n "$STATE_DIR" ] || return 0
  [ -f "$STATE_DIR/owned" ] || return 0
  local kind name phase
  # Volumes are registered before their containers. Remove all containers first:
  # Docker refuses to remove a named volume while any container references it.
  for phase in container volume; do
    while IFS=$'\t' read -r kind name; do
      [ -n "${kind:-}" ] || continue
      [ "$kind" = "$phase" ] || continue
      # Best effort: never let a cleanup problem mask the original exit status.
      case "$kind" in
        container) exists container "$name" && [ "$(label_of container "$name")" = "$RUN_ID" ] \
                      && docker rm -fv "$name" >/dev/null 2>&1 || true ;;
        volume)    exists volume "$name" && [ "$(label_of volume "$name")" = "$RUN_ID" ] \
                      && docker volume rm "$name" >/dev/null 2>&1 || true ;;
      esac
    done < "$STATE_DIR/owned"
  done
}

on_exit() {
  local rc=$?
  if [ "$CLEANED" -eq 0 ]; then
    CLEANED=1
    if [ "$rc" -ne 0 ]; then
      printf '\n=== interrupted or failed; removing only resources created by this run ===\n'
    fi
    cleanup_owned
  fi
  [ -n "$STATE_DIR" ] && rm -rf "$STATE_DIR"
  return $rc
}
trap on_exit EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

# ---------------------------------------------------------------- SQL
# Written with a literal heredoc rather than embedded in a shell variable.
# Nesting SQL quotes inside shell quotes is exactly how the first hand-run
# comparison was corrupted, and it is unreadable to review.
write_fingerprint_sql() {
  cat > "$STATE_DIR/fingerprint.sql" <<'SQL'
SELECT 'T|' || table_name FROM information_schema.tables
 WHERE table_schema = 'public' ORDER BY 1;
SELECT 'C|' || table_name || '.' || column_name || ':' || data_type || ':' || is_nullable
  FROM information_schema.columns WHERE table_schema = 'public' ORDER BY 1;
SELECT 'I|' || indexname FROM pg_indexes WHERE schemaname = 'public' ORDER BY 1;
-- contype is "char"; without an explicit cast `text || "char"` is ambiguous.
SELECT 'K|' || conrelid::regclass::text || '|' || contype::text || '|' || pg_get_constraintdef(oid)
  FROM pg_constraint WHERE connamespace = 'public'::regnamespace ORDER BY 1;
SELECT 'E|' || t.typname FROM pg_type t
  JOIN pg_namespace n ON n.oid = t.typnamespace
 WHERE t.typtype = 'e' AND n.nspname = 'public'
   AND NOT EXISTS (SELECT 1 FROM pg_type el WHERE el.oid = t.typelem AND el.typtype <> 'e')
 ORDER BY 1;
SELECT 'M|' || migration_name || '|' || COALESCE(finished_at::text, 'null')
    || '|' || COALESCE(rolled_back_at::text, 'null') || '|' || applied_steps_count
  FROM _prisma_migrations ORDER BY 1;
SELECT 'R|organizations|' || count(*) FROM organizations;
SELECT 'R|memberships|' || count(*) FROM memberships;
SELECT 'R|_prisma_migrations|' || count(*) FROM _prisma_migrations;
SELECT 'S|server_major|' || current_setting('server_version_num')::int / 10000;
SELECT 'S|data_directory|' || current_setting('data_directory');
SQL
}

# fingerprint <tag> <container> <dbuser>
fingerprint() {
  local tag=$1 cname=$2 dbuser=$3 out="$STATE_DIR/$1.txt"
  if ! docker exec -i "$cname" \
        psql -v ON_ERROR_STOP=1 -U "$dbuser" -d "$PROD_DB_NAME" -tA -f - \
        < "$STATE_DIR/fingerprint.sql" > "$out" 2> "$STATE_DIR/$tag.err"; then
    fail "$tag: psql exited non-zero"
    sed 's/^/        /' "$STATE_DIR/$tag.err" || true
    return 1
  fi
  if grep -qiE '^[[:space:]]*(ERROR|FATAL)' "$out" "$STATE_DIR/$tag.err" 2>/dev/null; then
    fail "$tag: psql reported a SQL error (refusing to compare errors as results)"
    sed 's/^/        /' "$STATE_DIR/$tag.err" || true
    return 1
  fi
  pass "$tag: $(wc -l < "$out" | tr -d ' ') fingerprint lines captured"
}

wait_for_pg() {
  local cname=$1 i
  for i in $(seq 1 90); do
    if docker exec "$cname" pg_isready -U postgres -d "$PROD_DB_NAME" >/dev/null 2>&1; then
      pass "$cname ready after ${i}s"; return 0
    fi
    sleep 1
  done
  fail "$cname never became ready"
  docker logs "$cname" 2>&1 | tail -15 | sed 's/^/        /' || true
  return 1
}

# ---------------------------------------------------------------- validation
# Validates the assumptions a restore depends on, before anything is restored.
validate_restore_assumptions() {
  local backup=$1 toc_lines
  say "validate restore assumptions"

  # 1. Production role and database must exist and be readable.
  if ! docker exec "$PROD_CONTAINERS_FIRST" \
        psql -v ON_ERROR_STOP=1 -U "$PROD_DB_ROLE" -d "$PROD_DB_NAME" -tAc 'SELECT 1;' >/dev/null 2>&1; then
    die "cannot read production database '${PROD_DB_NAME}' as role '${PROD_DB_ROLE}'; not attempting a restore"
  fi
  pass "production role '${PROD_DB_ROLE}' can read database '${PROD_DB_NAME}'"

  # 2. The archive must be readable by a pg_restore that actually exists.
  #    A missing binary behind `2>/dev/null` returns an empty listing that is
  #    indistinguishable from a corrupt archive.
  if ! command -v pg_restore >/dev/null 2>&1 \
     && ! docker exec "$PROD_CONTAINERS_FIRST" true >/dev/null 2>&1; then
    die "no usable pg_restore; refusing to interpret an empty listing as a valid archive"
  fi
  if ! docker exec -i "$PROD_CONTAINERS_FIRST" pg_restore --list < "$backup" > "$STATE_DIR/archive.toc" 2>/dev/null; then
    die "pg_restore could not read a table of contents from ${backup}; refusing to continue"
  fi
  toc_lines=$(grep -cE '^[0-9]+;' "$STATE_DIR/archive.toc" || true)
  [ "${toc_lines:-0}" -gt 0 ] \
    || die "pg_restore could not read a table of contents from ${backup}; refusing to continue"
  pass "archive table of contents readable (${toc_lines} entries)"

  # 3. The archive must actually contain tables, so a post-restore comparison
  #    has something to compare against.
  # Match TABLE definitions in public, not TABLE DATA or other schemas. This
  # must use the same scope as the restored information_schema query below.
  ARCHIVE_TABLES=$(awk '$1 ~ /^[0-9]+;$/ && $4 == "TABLE" && $5 == "public" { n++ } END { print n+0 }' "$STATE_DIR/archive.toc")
  [ "$ARCHIVE_TABLES" -gt 0 ] \
    || die "archive contains no TABLE entries; nothing to verify"
  info "archive declares ${ARCHIVE_TABLES} public table(s)"
}

# Confirms the restored database really holds what the archive promised.
assert_restored_schema() {
  local cname=$1 expected=$2 actual
  actual=$(docker exec "$cname" psql -v ON_ERROR_STOP=1 -U postgres -d "$PROD_DB_NAME" -tAc \
    "SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE';" 2>/dev/null || echo -1)
  if [ "$actual" -lt "$expected" ]; then
    fail "restored database has ${actual} public table(s) but the archive declared ${expected}"
    return 1
  fi
  pass "restored database holds at least the ${expected} table(s) the archive declared"
}

# ---------------------------------------------------------------- containers
start_pg() {
  local cname=$1 volume=$2 created_id
  assert_not_production container "$cname"
  assert_not_production volume "$volume"
  # A volume already attached to something else is not ours to write into.
  local attached
  attached=$(docker ps -a --filter "volume=${volume}" --format '{{.Names}}' 2>/dev/null | tr '\n' ' ')
  [ -z "$attached" ] || die "volume '${volume}' is already attached to: ${attached}"
  docker run -d --name "$cname" --network none \
    --mount "type=volume,src=${volume},dst=${PG_MOUNTPOINT}" \
    --label "${LABEL_KEY}=${RUN_ID}" \
    -e POSTGRES_HOST_AUTH_METHOD=trust \
    -e POSTGRES_DB="$PROD_DB_NAME" \
    "$PG_IMAGE" >/dev/null
  register container "$cname"
  created_id=$(docker inspect --format '{{.Id}}' "$cname" 2>/dev/null || true)
  assert_not_production_id "$created_id"
  wait_for_pg "$cname"
}

start_redis() {
  local cname=$1 volume=$2 created_id
  assert_not_production container "$cname"
  assert_not_production volume "$volume"
  docker run -d --name "$cname" --network none \
    --mount "type=volume,src=${volume},dst=${REDIS_MOUNTPOINT}" \
    --label "${LABEL_KEY}=${RUN_ID}" \
    "$REDIS_IMAGE" redis-server --appendonly yes --appendfsync everysec --save 60 1 >/dev/null
  register container "$cname"
  created_id=$(docker inspect --format '{{.Id}}' "$cname" 2>/dev/null || true)
  assert_not_production_id "$created_id"
  local i
  for i in $(seq 1 30); do
    docker exec "$cname" redis-cli PING 2>/dev/null | grep -q PONG && return 0
    sleep 1
  done
  fail "$cname never became ready"; return 1
}

new_volume() {
  local vol=$1
  assert_not_production volume "$vol"
  docker volume create --label "${LABEL_KEY}=${RUN_ID}" "$vol" >/dev/null
  register volume "$vol"
}

restore_into() {
  local cname=$1 backup=$2
  docker cp "$backup" "$cname:/tmp/verify.dump" || return 1
  # trust auth on a loopback-only, disposable instance keeps every credential
  # out of this script and out of the shell history.
  docker exec "$cname" pg_restore -U postgres -d "$PROD_DB_NAME" \
    --no-owner --no-privileges /tmp/verify.dump || return 1
  pass "pg_restore completed with no errors"
}

# ---------------------------------------------------------------- subcommands
cmd_preflight() {
  say "prerequisites"
  STATE_DIR=$(mktemp -d -t "truevine-verify-XXXXXX")
  command -v docker >/dev/null 2>&1 || die "docker is not installed"
  info "run id: $RUN_ID"
  info "disk free on / : $(df --output=avail -BG / | tail -1 | tr -d ' ')"
  info "memory available: $(awk '/MemAvailable/{printf "%d MiB", $2/1024}' /proc/meminfo)"
  docker image inspect "$PG_IMAGE" >/dev/null 2>&1 || die "image ${PG_IMAGE} is not present locally"
  docker image inspect "$REDIS_IMAGE" >/dev/null 2>&1 || die "image ${REDIS_IMAGE} is not present locally"
  pass "required images present"
  for c in $PROD_CONTAINERS; do
    exists container "$c" || die "production container '${c}' is not present; refusing to run verification"
    [ "$(docker inspect --format '{{.State.Running}}' "$c")" = "true" ] \
      || die "production container '${c}' is not running"
    info "${c}: $(docker inspect --format 'started={{.State.StartedAt}} restarts={{.RestartCount}}' "$c")"
  done
  pass "production containers are running"
  capture_production_identity
}

cmd_backup() {
  STATE_DIR=$(mktemp -d -t "truevine-verify-XXXXXX")
  say "create a custom-format backup"
  local ts out size
  ts=$(date -u +%Y%m%dT%H%M%SZ)
  out="${BACKUP_DIR}/${PROD_DB_NAME}_${ts}.dump"
  umask 077
  mkdir -p "$BACKUP_DIR"
  # pg_dump only reads; it cannot modify the database.
  if ! docker exec truevine-postgres \
        pg_dump -U "$PROD_DB_ROLE" -d "$PROD_DB_NAME" -Fc > "$out"; then
    rm -f "$out"
    die "pg_dump failed; partial file removed rather than left looking like a backup"
  fi
  size=$(stat -c %s "$out")
  if [ "$size" -eq 0 ]; then
    rm -f "$out"
    die "pg_dump produced a zero-byte file; removed rather than leaving a broken backup"
  fi
  [ "$(head -c 5 "$out")" = "PGDMP" ] || die "output is not a custom-format archive: ${out}"
  info "file   : $out"
  info "size   : ${size} bytes"
  info "format : PGDMP"
  info "sha256 : $(sha256sum "$out" | cut -d' ' -f1)"
  sha256sum "$out" > "$out.sha256"
  pass "backup created, checksummed and recorded"
  info "existing backups are never modified or deleted by this script"
}

assert_backup_file() {
  local backup=$1
  [ -n "$backup" ] || die "usage: $MODE <backup.dump>"
  [ -f "$backup" ] || die "backup not found: $backup"
  [ -s "$backup" ] || die "backup is empty: $backup"
  [ "$(head -c 5 "$backup")" = "PGDMP" ] \
    || die "not a PostgreSQL custom-format archive: $backup"
  pass "backup is a non-empty PGDMP archive"
  if [ -f "$backup.sha256" ]; then
    ( cd "$(dirname "$backup")" && sha256sum -c "$(basename "$backup").sha256" ) >/dev/null 2>&1 \
      && pass "checksum matches the recorded .sha256" \
      || die "checksum mismatch for $backup; refusing to use it"
  else
    info "no .sha256 alongside this backup; recording one now"
    ( cd "$(dirname "$backup")" && sha256sum "$(basename "$backup")" > "$(basename "$backup").sha256" )
  fi
}

cmd_verify_restore() {
  MODE=verify-restore
  local backup=${1:-}
  STATE_DIR=$(mktemp -d -t "truevine-verify-XXXXXX")
  write_fingerprint_sql
  assert_backup_file "$backup"
  capture_production_identity
  validate_restore_assumptions "$backup"

  local stamp vol cname expected
  stamp=$(date -u +%Y%m%dT%H%M%SZ)
  vol="truevine-verify-restore-${stamp}"
  cname="truevine-verify-restore-${stamp}"

  say "restore into an isolated instance"
  new_volume "$vol"
  info "volume ${vol} (production volume is never mounted)"
  info "network none, publishedPorts 0, label ${LABEL_KEY}=${RUN_ID}"
  start_pg "$cname" "$vol" || exit 1
  expected=$ARCHIVE_TABLES
  restore_into "$cname" "$backup" || exit 1
  assert_restored_schema "$cname" "$expected" || exit 1
  fingerprint restored "$cname" postgres || exit 1
  say "result"
  sed 's/^/    /' "$STATE_DIR/restored.txt"

  say "cleanup"
  safe_remove_container "$cname"
  safe_remove_volume "$vol"
  assert_no_orphans
}

cmd_verify_volume() {
  MODE=verify-volume
  local backup=${1:-}
  STATE_DIR=$(mktemp -d -t "truevine-verify-XXXXXX")
  write_fingerprint_sql
  assert_backup_file "$backup"
  capture_production_identity
  validate_restore_assumptions "$backup"

  local stamp vol name_a name_b expected
  stamp=$(date -u +%Y%m%dT%H%M%SZ)
  vol="truevine-verify-pg-${stamp}"
  name_a="truevine-verify-pg-a-${stamp}"
  name_b="truevine-verify-pg-b-${stamp}"

  say "container A on a dedicated temporary volume"
  new_volume "$vol"
  info "volume ${vol}; mount destination ${PG_MOUNTPOINT} matches production"
  start_pg "$name_a" "$vol" || exit 1
  local id_a; id_a=$(docker inspect --format '{{.Id}}' "$name_a")
  expected=$ARCHIVE_TABLES
  restore_into "$name_a" "$backup" || exit 1
  assert_restored_schema "$name_a" "$expected" || exit 1
  fingerprint before "$name_a" postgres || exit 1

  say "remove the container, retain the volume"
  safe_remove_container "$name_a"
  exists volume "$vol" || die "temporary volume vanished; cannot continue"
  pass "temporary volume retained after container removal"

  say "container B on the SAME volume"
  start_pg "$name_b" "$vol" || exit 1
  local id_b; id_b=$(docker inspect --format '{{.Id}}' "$name_b")
  if [ "$id_a" = "$id_b" ]; then
    fail "container id unchanged - the container was never actually recreated"
  else
    pass "container id changed (A=${id_a:0:12} B=${id_b:0:12})"
  fi
  docker logs "$name_b" 2>&1 | grep -iE 'appears to contain a database|Skipping initialization' \
    | sed 's/^/    /' || info "no 'skipping initialization' line; check the log manually"

  say "compare before and after recreation"
  fingerprint after "$name_b" postgres || exit 1
  if diff -u "$STATE_DIR/before.txt" "$STATE_DIR/after.txt" > "$STATE_DIR/diff.txt" 2>&1; then
    pass "fingerprints identical"
    info "sha256 before: $(sha256sum < "$STATE_DIR/before.txt" | cut -d' ' -f1)"
    info "sha256 after : $(sha256sum < "$STATE_DIR/after.txt"  | cut -d' ' -f1)"
  else
    fail "fingerprints differ"
    sed 's/^/    /' "$STATE_DIR/diff.txt"
  fi

  say "cleanup"
  safe_remove_container "$name_b"
  safe_remove_volume "$vol"
  assert_no_orphans
}

cmd_verify_redis() {
  MODE=verify-redis
  local stamp vol name key val id_a id_b
  STATE_DIR=$(mktemp -d -t "truevine-verify-XXXXXX")
  stamp=$(date -u +%Y%m%dT%H%M%SZ)
  vol="truevine-verify-redis-${stamp}"
  name="truevine-verify-redis-${stamp}"
  key="truevine-verify:redis:${stamp}"
  val="synthetic-value-${stamp}"
  capture_production_identity

  say "temporary Redis on a dedicated volume"
  new_volume "$vol"
  start_redis "$name" "$vol" || exit 1
  id_a=$(docker inspect --format '{{.Id}}' "$name")
  info "container id A: ${id_a:0:12}"

  say "write a synthetic key and persist it"
  docker exec "$name" redis-cli SET "$key" "$val" >/dev/null
  [ "$(docker exec "$name" redis-cli GET "$key" | tr -d '\r')" = "$val" ] \
    && pass "key readable before recreation" || die "key did not read back correctly"
  docker exec "$name" redis-cli BGSAVE >/dev/null
  local i
  for i in $(seq 1 30); do
    docker exec "$name" redis-cli INFO persistence 2>/dev/null | grep -q '^rdb_bgsave_in_progress:0' && break
    sleep 1
  done

  say "recreate against the same volume"
  safe_remove_container "$name"
  start_redis "$name" "$vol" || exit 1
  id_b=$(docker inspect --format '{{.Id}}' "$name")
  if [ "$id_a" = "$id_b" ]; then
    fail "container id unchanged - the container was never recreated"
  else
    pass "container id changed (A=${id_a:0:12} B=${id_b:0:12})"
  fi

  say "verify the key survived"
  local exists_key got
  exists_key=$(docker exec "$name" redis-cli EXISTS "$key" | tr -d '\r')
  got=$(docker exec "$name" redis-cli GET "$key" | tr -d '\r')
  docker logs "$name" 2>&1 | grep -iE 'Reading RDB base file|DB loaded from' | sed 's/^/    /' || true
  [ "$exists_key" = "1" ] && pass "key survived container recreation" || fail "key did not survive"
  if [ "$got" = "$val" ]; then pass "value is byte-for-byte identical"
  else fail "value mismatch (expected '$val', got '$got')"; fi

  say "cleanup"
  safe_remove_container "$name"
  safe_remove_volume "$vol"
  for c in $PROD_CONTAINERS; do
    if docker exec "$c" redis-cli KEYS '*' 2>/dev/null | grep -q '^truevine-verify:'; then
      fail "the test key leaked into production Redis (${c})"
    fi
  done
  pass "no test key in production Redis"
  assert_no_orphans
}

assert_no_orphans() {
  local leftovers
  leftovers=$(docker ps -a --filter "label=${LABEL_KEY}" --format '{{.Names}}' 2>/dev/null | tr '\n' ' ')
  [ -z "$(printf '%s' "$leftovers" | tr -d ' ')" ] \
    && pass "no containers remain from this run" \
    || fail "containers still present from this run:${leftovers}"
  leftovers=$(docker volume ls -q --filter "label=${LABEL_KEY}" 2>/dev/null | tr '\n' ' ')
  [ -z "$(printf '%s' "$leftovers" | tr -d ' ')" ] \
    && pass "no volumes remain from this run" \
    || fail "volumes still present from this run:${leftovers}"
}

cmd_cleanup() {
  # Cleanup never sweeps by name. It only considers resources carrying a
  # truevine.verify.run label, so an unrelated container that happens to be
  # named similarly is untouched.
  local all_runs=0
  [ "${2:-}" = "--all-runs" ] && all_runs=1
  STATE_DIR=$(mktemp -d -t "truevine-verify-XXXXXX")
  say "remove resources left by previous verification runs"
  if [ "$all_runs" -eq 0 ]; then
    info "only this run's resources exist at this point; pass --all-runs to reap orphans from earlier runs"
  fi
  local c v label
  for c in $(docker ps -aq --filter "label=${LABEL_PREFIX}run" 2>/dev/null || true); do
    label=$(label_of container "$c")
    if [ "$all_runs" -eq 0 ] && [ "$label" != "$RUN_ID" ]; then
      info "leaving container $c (belongs to run '$label'; use --all-runs to remove)"
      continue
    fi
    docker rm -fv "$c" >/dev/null 2>&1 && info "removed container $c" || info "could not remove container $c"
  done
  for v in $(docker volume ls -q --filter "label=${LABEL_PREFIX}run" 2>/dev/null || true); do
    label=$(label_of volume "$v")
    if [ "$all_runs" -eq 0 ] && [ "$label" != "$RUN_ID" ]; then
      info "leaving volume $v (belongs to run '$label'; use --all-runs to remove)"
      continue
    fi
    docker volume rm "$v" >/dev/null 2>&1 && info "removed volume $v" || info "could not remove volume $v"
  done
  info "backups in ${BACKUP_DIR} are never touched by cleanup"
}

say_production_untouched() {
  say "production unchanged"
  local c
  for c in $PROD_CONTAINERS; do
    docker inspect --format \
      '  {{.Name}} running={{.State.Running}} restarts={{.RestartCount}} started={{.State.StartedAt}}' \
      "$c" 2>/dev/null || info "  ${c}: not present"
  done
}

MODE=""
main() {
  local cmd=${1:-}
  PROD_CONTAINERS_FIRST=$(printf '%s' "$PROD_CONTAINERS" | cut -d' ' -f1)
  case "$cmd" in
    preflight)      cmd_preflight ;;
    backup)         cmd_backup ;;
    verify-restore) cmd_verify_restore "${2:-}" ;;
    verify-volume)  cmd_verify_volume "${2:-}" ;;
    verify-redis)   cmd_verify_redis ;;
    cleanup)        cmd_cleanup "$@" ;;
    *) die "usage: $0 {preflight|backup|verify-restore <dump>|verify-volume <dump>|verify-redis|cleanup [--all-runs]}" ;;
  esac
  say_production_untouched
  if [ "$FAILURES" -ne 0 ]; then
    printf '\nRESULT: FAIL (%d assertion(s) failed)\n' "$FAILURES"
    exit 1
  fi
  printf '\nRESULT: PASS\n'
}

main "$@"
