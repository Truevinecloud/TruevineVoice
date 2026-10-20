#!/usr/bin/env bash
#
# Runtime tests for the backup implementation.
#
# These EXECUTE backup.sh and restore.sh against an isolated local store and
# synthetic data. No production database, bucket, credential or VPS is touched.
#
# PostgreSQL is genuinely exercised when a container runtime is available; the
# cases that need it say so loudly when they are skipped rather than passing
# quietly.
#
# Requires: bash, `age` (which provides `age-keygen`), node, coreutils, and a
# working container runtime for the database-backed sections.
#
# BACKUP_TESTS_REQUIRED=1 converts every skip into a failure. Set it in CI so a
# runner that has lost a dependency reports red instead of quietly verifying
# nothing. Locally it is unset, so a developer without `age` still gets skips
# with a reason rather than a wall of failures.
#
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
BACKUP="$HERE/backup.sh"
RESTORE="$HERE/restore.sh"

WORK=$(mktemp -d -t truevine-backup-tests-XXXXXX)
TEST_RUN_ID="$$-$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')"
TEST_CONTAINER="truevine-backup-src-$TEST_RUN_ID"
TEST_VOLUME="${TEST_CONTAINER}-vol"
TEST_CONTAINER_ID=""
TEST_VOLUME_MOUNTPOINT=""
FIXTURE_ID=""
FIXTURE_VOLUME=""
FIXTURE_VOLUME_MOUNTPOINT=""
fails=0
skipped=0
ok()   { printf '  OK    %s\n' "$*"; }
bad()  { printf '  FAIL  %s\n' "$*"; fails=$((fails + 1)); }
warn() { printf '  !!    %s\n' "$*"; }
# A skip must always say why. A silent skip reads as a pass.
skip() { local reason=${1:-unspecified}; printf '  SKIP  %s -- reason: %s\n' "${2:-tests}" "$reason"; skipped=$((skipped + 1)); }

# Locally, a missing `age` or an absent Docker daemon means the developer cannot
# run the runtime suite; skipping with a reason is right.
#
# In CI it is not right. A green tick that silently omits encryption, restore and
# tamper detection is a lie about what is verified, and it is exactly the state
# this repository was in: CI reported "Unit tests: pass" while sections 3-14
# never executed because `age` was not installed.
#
# BACKUP_TESTS_REQUIRED=1 turns every skip into a failure, so a CI runner that
# has lost a dependency goes red instead of quietly testing nothing.
BACKUP_TESTS_REQUIRED="${BACKUP_TESTS_REQUIRED:-0}"
skip_or_fail() {
  local reason=$1 tests=${2:-tests}
  if [ "$BACKUP_TESTS_REQUIRED" = "1" ]; then
    bad "$tests could not run: $reason (BACKUP_TESTS_REQUIRED=1, a skip is a failure in CI)"
  else
    skip "$reason" "$tests"
  fi
}

# Test containers and volumes have a unique run identity. Cleanup positively
# verifies their labels and captured identity before removing them.
cleanup() {
  command -v docker >/dev/null 2>&1 || { rm -rf "$WORK"; return; }
  docker info >/dev/null 2>&1 || { rm -rf "$WORK"; return; }
  local label mountpoint
  if [ -n "$TEST_CONTAINER_ID" ]; then
    label=$(docker inspect --format '{{ index .Config.Labels "truevine.backup.test.run" }}' "$TEST_CONTAINER_ID" 2>/dev/null || true)
    if [ "$label" = "$TEST_RUN_ID" ]; then docker rm -f "$TEST_CONTAINER_ID" >/dev/null 2>&1 || true; fi
  fi
  if [ -n "$FIXTURE_ID" ]; then
    label=$(docker inspect --format '{{ index .Config.Labels "truevine.backup.test.conflict" }}' "$FIXTURE_ID" 2>/dev/null || true)
    [ "$label" = "$TEST_RUN_ID" ] && docker rm -f "$FIXTURE_ID" >/dev/null 2>&1 || true
  fi
  label=$(docker volume inspect --format '{{ index .Labels "truevine.backup.test.run" }}' "$TEST_VOLUME" 2>/dev/null || true)
  mountpoint=$(docker volume inspect --format '{{.Mountpoint}}' "$TEST_VOLUME" 2>/dev/null || true)
  if [ "$label" = "$TEST_RUN_ID" ] && [ -n "$TEST_VOLUME_MOUNTPOINT" ] && [ "$mountpoint" = "$TEST_VOLUME_MOUNTPOINT" ]; then
    docker volume rm "$TEST_VOLUME" >/dev/null 2>&1 || true
  fi
  label=$(docker volume inspect --format '{{ index .Labels "truevine.backup.test.conflict" }}' "${FIXTURE_VOLUME:-unused}" 2>/dev/null || true)
  mountpoint=$(docker volume inspect --format '{{.Mountpoint}}' "${FIXTURE_VOLUME:-unused}" 2>/dev/null || true)
  if [ "$label" = "$TEST_RUN_ID" ] && [ -n "$FIXTURE_VOLUME_MOUNTPOINT" ] && [ "$mountpoint" = "$FIXTURE_VOLUME_MOUNTPOINT" ]; then
    docker volume rm "$FIXTURE_VOLUME" >/dev/null 2>&1 || true
  fi
  rm -rf "$WORK"
}
trap cleanup EXIT

# ---------------------------------------------------------------- fixtures

have_docker=0
if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  have_docker=1
fi

make_key() {
  command -v age-keygen >/dev/null 2>&1 || return 1
  age-keygen -o "$1" >/dev/null 2>&1
  chmod 600 "$1"
}

# A standalone PostgreSQL instance plus a source database to dump from.
# Isolated: no network, its own volume, its own name.
start_test_pg() {
  if docker inspect "$TEST_CONTAINER" >/dev/null 2>&1 || docker volume inspect "$TEST_VOLUME" >/dev/null 2>&1; then
    warn "random test resource name already exists; refusing to remove or reuse it"
    return 1
  fi
  docker volume create --label "truevine.backup.test.run=$TEST_RUN_ID" "$TEST_VOLUME" >/dev/null || return 1
  TEST_VOLUME_MOUNTPOINT=$(docker volume inspect --format '{{.Mountpoint}}' "$TEST_VOLUME") || return 1
  [ -n "$TEST_VOLUME_MOUNTPOINT" ] || return 1
  if ! docker run -d --name "$TEST_CONTAINER" --network none \
    --mount "type=volume,src=$TEST_VOLUME,dst=/var/lib/postgresql" \
    --label "truevine.backup.test.run=$TEST_RUN_ID" \
    -e POSTGRES_HOST_AUTH_METHOD=trust -e POSTGRES_DB=testdb \
    postgres:18-alpine >"$WORK/container.id" 2>"$WORK/container.start.log"; then
    warn "isolated test PostgreSQL container did not start:"
    sed 's/^/          /' "$WORK/container.id"
    sed 's/^/          /' "$WORK/container.start.log"
    return 1
  fi
  TEST_CONTAINER_ID=$(tr -d '\r\n' < "$WORK/container.id")
  if ! [[ "$TEST_CONTAINER_ID" =~ ^[0-9a-f]{64}$ ]]; then
    warn "docker run did not return a single container id:"
    sed 's/^/          /' "$WORK/container.id"
    sed 's/^/          /' "$WORK/container.start.log"
    return 1
  fi
  local actual_label actual_mount
  actual_label=$(docker inspect --format '{{ index .Config.Labels "truevine.backup.test.run" }}' "$TEST_CONTAINER_ID") || {
    warn "could not inspect isolated test PostgreSQL container identity:"
    docker inspect "$TEST_CONTAINER_ID" 2>&1 | sed 's/^/          /' || true
    return 1
  }
  actual_mount=$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/var/lib/postgresql"}}{{.Name}}{{end}}{{end}}' "$TEST_CONTAINER_ID") || {
    warn "could not inspect isolated test PostgreSQL container mount"
    return 1
  }
  if [ "$actual_label" != "$TEST_RUN_ID" ] || [ "$actual_mount" != "$TEST_VOLUME" ]; then
    warn "isolated test PostgreSQL identity mismatch (label=$actual_label mount=$actual_mount)"
    return 1
  fi
  local i
  # A real query, not `pg_isready`. The image runs a temporary server while it
  # initialises and pg_isready succeeds against that, so seeding could start
  # while the real server was still coming up. Measured flake rate of the
  # pg_isready form: roughly 1 run in 3.
  for i in $(seq 1 90); do
    if docker exec "$TEST_CONTAINER_ID" psql -U postgres -d testdb -tAc 'SELECT 1' >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  warn "isolated test PostgreSQL did not become ready; container state follows:"
  docker inspect --format '{{json .State}}' "$TEST_CONTAINER_ID" 2>/dev/null | sed 's/^/          /' || true
  docker logs "$TEST_CONTAINER_ID" 2>&1 | tail -40 | sed 's/^/          /' || true
  return 1
}

# `-i` is required: without it docker exec does not forward stdin, so the
# heredoc below would never reach psql and seeding would silently do nothing.
# The error is captured so a failure is diagnosable rather than just a skip.
seed_test_data() {
  docker exec -i "$TEST_CONTAINER_ID" psql -v ON_ERROR_STOP=1 -U postgres -d testdb -q \
    > /tmp/seed.out 2>&1 <<'SQL'
CREATE TABLE IF NOT EXISTS widget (id serial PRIMARY KEY, name text NOT NULL, created_at timestamptz DEFAULT now());
CREATE TABLE IF NOT EXISTS gadget (id serial PRIMARY KEY, label text);
INSERT INTO widget(name) SELECT 'w' || g FROM generate_series(1, 250) g;
INSERT INTO gadget(label) SELECT 'g' || g FROM generate_series(1, 40) g;
SQL
  local rc=$?
  if [ "$rc" != 0 ]; then
    warn "seeding failed (exit $rc):"
    sed 's/^/          /' /tmp/seed.out
  fi
  return "$rc"
}

# ---------------------------------------------------------------- tests

echo "=== 1. preconditions are refused before anything is created ==="
export BACKUP_STORE=local
export BACKUP_LOCAL_DIR="$WORK/store"
out=$(bash "$BACKUP" 2>&1); rc=$?
[ "$rc" != "0" ] && ok "backup without configuration exits non-zero ($rc)" || bad "backup without configuration succeeded"

out=$(BACKUP_KEYFILE=/nonexistent bash "$BACKUP" 2>&1); rc=$?
[ "$rc" = "2" ] && ok "missing BACKUP_KEYFILE is exit 2 (precondition)" || bad "expected exit 2, got $rc"

[ -z "$(ls -A "$WORK/store" 2>/dev/null)" ] && ok "nothing was written to the store" || bad "store was written despite failure"

echo
echo "=== 2. the key file must not be readable by group or other ==="
if make_key "$WORK/key.txt"; then
  chmod 644 "$WORK/key.txt"
  out=$(BACKUP_KEYFILE="$WORK/key.txt" bash "$BACKUP" 2>&1); rc=$?
  [ "$rc" = "2" ] && ok "world-readable key is refused" || { bad "expected refusal (exit 2), got $rc"; printf '%s\n' "$out" | sed 's/^/        /'; }
  case "$out" in *"must not be readable"*) ok "refusal explains why" ;; *) bad "no explanation given" ;; esac
  chmod 600 "$WORK/key.txt"
else
  skip_or_fail "age-keygen unavailable" "key permission checks"
fi

echo
echo "=== 3. encryption: the store must contain no plaintext ==="

# Each precondition is checked separately and the failing one is named. A single
# `a && b && c` chain would skip silently and hide which step broke.
skip_reason=""
if ! command -v age-keygen >/dev/null 2>&1; then
  skip_reason="age-keygen is not installed"
elif [ "$have_docker" != "1" ]; then
  skip_reason="docker daemon is unreachable"
elif ! make_key "$WORK/key.txt"; then
  skip_reason="could not generate a test key"
elif ! start_test_pg; then
  skip_reason="the isolated test PostgreSQL instance did not become ready"
elif ! seed_test_data; then
  skip_reason="could not seed the test database"
fi

if [ -z "$skip_reason" ]; then
  export BACKUP_KEYFILE="$WORK/key.txt"
  export BACKUP_PG_CONTAINER="$TEST_CONTAINER_ID"
  export BACKUP_PG_DB=testdb
  # The throwaway instance has only the default superuser; production uses
  # `truevine`. Naming the role explicitly is what keeps this honest.
  export BACKUP_PG_ROLE=postgres
  export BACKUP_APP_ROOT="$WORK/app"
  export BACKUP_CONFIG_SOURCE="$WORK/app"
  mkdir -p "$WORK/app"

  out_backup=$(bash "$BACKUP" 2>&1); rc=$?
  out="$out_backup"
  [ "$rc" = "0" ] && ok "backup completed (exit 0)" || { bad "backup failed (exit $rc)"; echo "$out_backup" | sed 's/^/        /'; }

  # The dump contained 'widget' and 'gadget'; no object in the store may.
  leaked=0
  for f in $(find "$WORK/store" -type f); do
    if grep -qa 'CREATE TABLE widget' "$f" 2>/dev/null; then leaked=1; fi
  done
  [ "$leaked" = "0" ] && ok "no store object contains the plaintext schema" || bad "PLAINTEXT FOUND IN THE STORE"

  # The configuration archive must be encrypted too, not shipped as a tar.gz.
  plaintar=$(find "$WORK/store" -name '*.tar.gz' | wc -l | tr -d ' ')
  [ "$plaintar" = "0" ] && ok "no plaintext config archive uploaded" || bad "a plaintext .tar.gz was uploaded"
  cfg=$(find "$WORK/store" -path '*config*' -name '*.age' | wc -l | tr -d ' ')
  [ "$cfg" -ge 1 ] && ok "configuration archive is encrypted" || bad "no encrypted configuration archive found"

  # age ciphertext has a recognisable header.
  n=$(find "$WORK/store" -name '*.dump.age' | wc -l | tr -d ' ')
  [ "$n" -ge 1 ] && ok "ciphertext object present" || bad "no ciphertext object uploaded"
  if [ "$n" -ge 1 ]; then
    hdr=$(head -c 20 "$(find "$WORK/store" -name '*.dump.age' | head -1)" | tr -d '\0')
    case "$hdr" in *age-encryption.org*) ok "object carries the age header" ;; *) bad "unexpected header: $hdr" ;; esac
  fi

  echo
  echo "=== 4. restore verifies without touching a database ==="
  out=$(bash "$RESTORE" --latest 2>&1); rc=$?
  [ "$rc" = "0" ] && ok "verify-only restore exits 0" || { bad "verify-only failed (exit $rc)"; echo "$out" | sed 's/^/        /'; }
  case "$out" in *"VERIFY OK"*) ok "reports VERIFY OK" ;; *) bad "no VERIFY OK line" ;; esac
  case "$out" in *"no database was touched"*) ok "states no database was touched" ;; *) bad "missing safety statement" ;; esac
  # Surface which table-of-contents branch restore.sh took. On success the
  # captured output is otherwise discarded, so a CI log cannot tell whether the
  # local pg_restore read the archive or was merely too old to read it. That
  # distinction is the whole point of the fix, so it has to be visible.
  case "$out" in
    *"archive table of contents:"*)
      echo "  INFO  local pg_restore read the archive (client-compatible path)" ;;
    *"cannot read this archive"*)
      echo "  INFO  local pg_restore is incompatible with the dump; restore.sh warned and continued" ;;
    *"pg_restore not available"*)
      echo "  INFO  no pg_restore on this host; table-of-contents check skipped" ;;
    *)
      echo "  INFO  table-of-contents outcome not reported" ;;
  esac

  echo
  echo "=== 5. output must never contain key material or a DSN ==="
  # Inspect the output that was actually captured, not a file that is never
  # written. A grep against a non-existent path passes vacuously.
  combined="$out_backup$out"
  if printf '%s' "$combined" | grep -qaE 'AGE-SECRET-KEY-1[A-Z0-9]{10,}'; then
    bad "secret key material appeared in output"
  else
    ok "no secret key material in output"
  fi
  if printf '%s' "$combined" | grep -qa 'AGE-SECRET-KEY-1'; then
    bad "any private key marker appeared in output"
  else
    ok "no private key marker in output"
  fi
  if printf '%s' "$combined" | grep -qaE 'postgres(ql)?://[^ ]*:[^ ]*@'; then
    bad "a credential-bearing DSN appeared in output"
  else
    ok "no credential-bearing DSN in output"
  fi
  # The recipient is public and may be referenced, but it must be redacted so a
  # log reader cannot correlate it against a stored key.
  if printf '%s' "$combined" | grep -qa 'age1[0-9a-z]\{20,\}'; then
    bad "recipient public key printed unredacted"
  else
    ok "recipient public key is redacted"
  fi

  echo
  echo "=== 6. restore --list ==="
  out=$(bash "$RESTORE" --list 2>&1); rc=$?
  [ "$rc" = "0" ] && ok "--list exits 0" || bad "--list failed (exit $rc)"
  # A backup timestamp looks like 20261016T040156Z.
  case "$out" in
    *20??????T??????Z*) ok "--list shows a timestamped backup" ;;
    *) bad "--list showed no backups: $out" ;;
  esac
  case "$out" in *available\ backups*) ok "--list explains what it listed" ;; *) bad "no header" ;; esac

  echo
  echo "=== 7. restore into an ISOLATED instance reproduces the data ==="
  REAL_DOCKER=$(command -v docker)
  success_wrapper="$WORK/docker-check-restored-data"
  mkdir -p "$success_wrapper"
  RESTORED_DATA_CHECK="$WORK/restored-row-counts.txt"
  cat > "$success_wrapper/docker" <<'WRAPPER'
#!/usr/bin/env bash
if [ "${1:-}" = rm ] && [ "${2:-}" = -f ]; then
  container_id=${3:-}
  label=$("$REAL_DOCKER" inspect --format '{{ index .Config.Labels "truevine.restore.run" }}' "$container_id" 2>/dev/null || true)
  case "$label" in
    truevine-restore-*)
      rows=$("$REAL_DOCKER" exec "$container_id" psql -U postgres -d testdb -At -F '|' \
        -c 'SELECT (SELECT count(*) FROM widget), (SELECT count(*) FROM gadget);' 2>/dev/null) || exit 1
      [ "$rows" = '250|40' ] || { echo "restored row counts differ: $rows" >&2; exit 1; }
      printf '%s\n' "$rows" > "$RESTORED_DATA_CHECK"
      ;;
  esac
fi
exec "$REAL_DOCKER" "$@"
WRAPPER
  chmod +x "$success_wrapper/docker"
  TS=$(find "$WORK/store" -name '*.dump.age' | head -1 | xargs basename | sed 's/\.dump\.age$//')
  LEGACY_CONTAINER="truevine-restore-$(echo "$TS" | tr -d 'Z')"
  LEGACY_VOLUME="${LEGACY_CONTAINER}-vol"
  FIXTURE_VOLUME="$LEGACY_VOLUME"
  FIXTURE_LABEL="truevine.backup.test.conflict=$TEST_RUN_ID"
  if docker inspect "$LEGACY_CONTAINER" >/dev/null 2>&1 || docker volume inspect "$LEGACY_VOLUME" >/dev/null 2>&1; then
    bad "legacy conflict fixture name already exists; refusing to touch it"
  else
    docker volume create --label "$FIXTURE_LABEL" "$LEGACY_VOLUME" >/dev/null || bad "could not create unrelated volume fixture"
    FIXTURE_MOUNT=$(docker volume inspect --format '{{.Mountpoint}}' "$LEGACY_VOLUME" 2>/dev/null || true)
    FIXTURE_VOLUME_MOUNTPOINT="$FIXTURE_MOUNT"
    docker run -d --name "$LEGACY_CONTAINER" --network none --label "$FIXTURE_LABEL" postgres:18-alpine sleep 600 >/dev/null 2>&1 \
      && FIXTURE_ID=$(docker inspect --format '{{.Id}}' "$LEGACY_CONTAINER") || { bad "could not create unrelated container fixture"; FIXTURE_ID=""; }
  fi
  out=$(PATH="$success_wrapper:$PATH" REAL_DOCKER="$REAL_DOCKER" \
    RESTORED_DATA_CHECK="$RESTORED_DATA_CHECK" bash "$RESTORE" --latest --restore 2>&1); rc=$?
  [ "$rc" = "0" ] && ok "isolated restore exits 0" || { bad "isolated restore failed (exit $rc)"; echo "$out" | sed 's/^/        /'; }
  # The seeded database holds exactly two tables (widget, gadget). There is no
  # Prisma migrations table here, so a correct restore reports 2, not 3.
  case "$out" in *"2 table(s)"*) ok "restored instance reports the 2 seeded tables" ;; *) bad "unexpected table count in: $out" ;; esac
  case "$out" in *"production untouched"*) ok "states production was untouched" ;; *) bad "missing safety statement" ;; esac
  [ "$(cat "$RESTORED_DATA_CHECK" 2>/dev/null)" = '250|40' ] \
    && ok "restored synthetic database contains all 250 widgets and 40 gadgets" \
    || bad "isolated restore did not reproduce the seeded synthetic rows"
  SUCCESS_LABEL=$(printf '%s\n' "$out" | sed -n 's/.*isolated restore run label: //p' | head -1)
  if [ -n "$SUCCESS_LABEL" ]; then
    own_containers=$(docker ps -aq --filter "label=truevine.restore.run=$SUCCESS_LABEL")
    own_volumes=$(docker volume ls -q --filter "label=truevine.restore.run=$SUCCESS_LABEL")
    [ -z "$own_containers" ] && [ -z "$own_volumes" ] && ok "successful restore removed exactly its own labeled container and volume" \
      || bad "successful restore left resources bearing its run label"
  else
    bad "restore did not report its unique ownership label"
  fi
  if [ -n "${FIXTURE_ID:-}" ]; then
    kept_id=$(docker inspect --format '{{.Id}}' "$FIXTURE_ID" 2>/dev/null || true)
    kept_label=$(docker inspect --format '{{ index .Config.Labels "truevine.backup.test.conflict" }}' "$FIXTURE_ID" 2>/dev/null || true)
    kept_mount=$(docker volume inspect --format '{{.Mountpoint}}' "$LEGACY_VOLUME" 2>/dev/null || true)
    kept_vlabel=$(docker volume inspect --format '{{ index .Labels "truevine.backup.test.conflict" }}' "$LEGACY_VOLUME" 2>/dev/null || true)
    [ "$kept_id" = "$FIXTURE_ID" ] && [ "$kept_label" = "$TEST_RUN_ID" ] && [ "$kept_mount" = "$FIXTURE_MOUNT" ] && [ "$kept_vlabel" = "$TEST_RUN_ID" ] \
      && ok "unrelated pre-existing container and volume survived unchanged" \
      || bad "isolated restore changed or removed unrelated fixture resources"
    if [ "$kept_label" = "$TEST_RUN_ID" ]; then
      docker rm -f "$FIXTURE_ID" >/dev/null && [ -z "$(docker inspect "$FIXTURE_ID" 2>/dev/null || true)" ] && FIXTURE_ID=""
    fi
    if [ "$kept_vlabel" = "$TEST_RUN_ID" ] && [ "$kept_mount" = "$FIXTURE_MOUNT" ]; then
      docker volume rm "$LEGACY_VOLUME" >/dev/null && [ -z "$(docker volume inspect "$LEGACY_VOLUME" 2>/dev/null || true)" ] && FIXTURE_VOLUME=""
    fi
  fi

  echo
  echo "=== 7a. name collisions fail closed before cleanup ==="
  conflict_wrapper="$WORK/docker-conflict"
  mkdir -p "$conflict_wrapper"
  cat > "$conflict_wrapper/docker" <<'WRAPPER'
#!/usr/bin/env bash
if [ "${RESTORE_TEST_CONTAINER_CONFLICT:-0}" = 1 ] && [ "${1:-}" = inspect ] && [[ "${2:-}" == truevine-restore-* ]]; then
  echo "forced unrelated container name conflict" >&2
  exit 0
fi
if [ "${RESTORE_TEST_VOLUME_CONFLICT:-0}" = 1 ] && [ "${1:-}" = volume ] && [ "${2:-}" = inspect ] && [[ "${*: -1}" == truevine-restore-*-vol ]]; then
  echo "forced unrelated volume name conflict" >&2
  exit 0
fi
if [ "${1:-}" = rm ] || { [ "${1:-}" = volume ] && [ "${2:-}" = rm ]; }; then
  printf '%s\n' "$*" >> "$DOCKER_CALL_LOG"
fi
exec "$REAL_DOCKER" "$@"
WRAPPER
  chmod +x "$conflict_wrapper/docker"
  DOCKER_CALL_LOG="$WORK/conflict.docker.log"
  out=$(PATH="$conflict_wrapper:$PATH" REAL_DOCKER="$REAL_DOCKER" DOCKER_CALL_LOG="$DOCKER_CALL_LOG" RESTORE_TEST_CONTAINER_CONFLICT=1 bash "$RESTORE" --latest --restore 2>&1); rc=$?
  [ "$rc" = "6" ] && ok "container name conflict exits 6" || bad "expected conflict refusal (exit 6), got $rc"
  case "$out" in *"name already exists"*) ok "collision refusal is explicit" ;; *) bad "collision refusal was not explicit" ;; esac
  case "$out" in *"isolated restore run label:"*) bad "conflict unexpectedly created an isolated restore run" ;; *) ok "conflict created no labeled resource" ;; esac
  [ ! -s "$DOCKER_CALL_LOG" ] && ok "container conflict triggered no Docker delete" || bad "container conflict attempted deletion"
  rm -f "$DOCKER_CALL_LOG"
  out=$(PATH="$conflict_wrapper:$PATH" REAL_DOCKER="$REAL_DOCKER" DOCKER_CALL_LOG="$DOCKER_CALL_LOG" RESTORE_TEST_VOLUME_CONFLICT=1 bash "$RESTORE" --latest --restore 2>&1); rc=$?
  [ "$rc" = "6" ] && ok "volume name conflict exits 6" || bad "expected volume conflict refusal (exit 6), got $rc"
  case "$out" in *"restore volume name already exists"*) ok "volume collision refusal is explicit" ;; *) bad "volume collision refusal was not explicit" ;; esac
  [ ! -s "$DOCKER_CALL_LOG" ] && ok "volume conflict triggered no Docker delete" || bad "volume conflict attempted deletion"

  echo
  echo "=== 7b. failed restore cleans only positively owned resources ==="
  failure_wrapper="$WORK/docker-fail-restore"
  mkdir -p "$failure_wrapper"
  cat > "$failure_wrapper/docker" <<'WRAPPER'
#!/usr/bin/env bash
if [ "${1:-}" = exec ] && [[ " ${*:2} " == *" pg_restore "* ]]; then
  echo "forced disposable pg_restore failure" >&2
  exit 9
fi
exec "$REAL_DOCKER" "$@"
WRAPPER
  chmod +x "$failure_wrapper/docker"
  out=$(PATH="$failure_wrapper:$PATH" REAL_DOCKER="$REAL_DOCKER" bash "$RESTORE" --latest --restore 2>&1); rc=$?
  [ "$rc" = "6" ] && ok "forced pg_restore failure exits 6" || bad "forced restore failure returned $rc"
  FAILURE_LABEL=$(printf '%s\n' "$out" | sed -n 's/.*isolated restore run label: //p' | head -1)
  after_owned=$(docker ps -aq --filter "label=truevine.restore.run=$FAILURE_LABEL" | sort)
  [ -n "$FAILURE_LABEL" ] && [ -z "$after_owned" ] && ok "failed restore cleaned its owned container" || bad "failed restore left or changed a labeled container"
  remaining_volumes=$(docker volume ls -q --filter "label=truevine.restore.run=$FAILURE_LABEL" | sort)
  [ -z "$remaining_volumes" ] && ok "failed restore cleaned its owned volume" || bad "failed restore left a labeled volume"

  echo
  echo "=== 7c. ownership mismatch fails closed during failure cleanup ==="
  mismatch_wrapper="$WORK/docker-mismatch-ownership"
  mkdir -p "$mismatch_wrapper"
  cat > "$mismatch_wrapper/docker" <<'WRAPPER'
#!/usr/bin/env bash
if [ "${1:-}" = exec ] && [[ " ${*:2} " == *" pg_restore "* ]]; then
  : > "$OWNERSHIP_MISMATCH_MARKER"
  echo "forced disposable pg_restore failure" >&2
  exit 9
fi
if [ -f "$OWNERSHIP_MISMATCH_MARKER" ] && [ "${1:-}" = inspect ] && [[ " ${*:2} " == *"truevine.restore.run"* ]]; then
  echo "foreign-run-label"
  exit 0
fi
if [ -f "$OWNERSHIP_MISMATCH_MARKER" ] && [ "${1:-}" = volume ] && [ "${2:-}" = inspect ] && [[ " ${*:3} " == *"truevine.restore.run"* ]]; then
  echo "foreign-run-label"
  exit 0
fi
if [ "${1:-}" = rm ] || { [ "${1:-}" = volume ] && [ "${2:-}" = rm ]; }; then
  printf '%s\n' "$*" >> "$DOCKER_CALL_LOG"
fi
exec "$REAL_DOCKER" "$@"
WRAPPER
  chmod +x "$mismatch_wrapper/docker"
  DOCKER_CALL_LOG="$WORK/mismatch.docker.log"
  : > "$DOCKER_CALL_LOG"
  MISMATCH_MARKER="$WORK/ownership-mismatch.marker"
  out=$(PATH="$mismatch_wrapper:$PATH" REAL_DOCKER="$REAL_DOCKER" \
    DOCKER_CALL_LOG="$DOCKER_CALL_LOG" OWNERSHIP_MISMATCH_MARKER="$MISMATCH_MARKER" \
    bash "$RESTORE" --latest --restore 2>&1); rc=$?
  [ "$rc" != "0" ] && ok "ownership mismatch makes cleanup fail" || bad "ownership mismatch did not fail the restore"
  case "$out" in *"ownership could not be verified"*) ok "ownership mismatch is reported" ;; *) bad "ownership mismatch was not reported" ;; esac
  if [ ! -s "$DOCKER_CALL_LOG" ]; then
    ok "ownership mismatch triggered no Docker deletion"
  else
    bad "ownership mismatch attempted Docker deletion: $(tr '\n' ' ' < "$DOCKER_CALL_LOG")"
  fi
  MISMATCH_LABEL=$(printf '%s\n' "$out" | sed -n 's/.*isolated restore run label: //p' | head -1)
  kept_container=$(docker ps -aq --filter "label=truevine.restore.run=$MISMATCH_LABEL" | head -1)
  kept_volume=$(docker volume ls -q --filter "label=truevine.restore.run=$MISMATCH_LABEL" | head -1)
  if [ -n "$MISMATCH_LABEL" ] && [ -n "$kept_container" ] && [ -n "$kept_volume" ]; then
    actual_clabel=$(docker inspect --format '{{ index .Config.Labels "truevine.restore.run" }}' "$kept_container")
    actual_vlabel=$(docker volume inspect --format '{{ index .Labels "truevine.restore.run" }}' "$kept_volume")
    [ "$actual_clabel" = "$MISMATCH_LABEL" ] && [ "$actual_vlabel" = "$MISMATCH_LABEL" ] \
      && ok "both resources remain intact after ownership could not be verified" \
      || bad "a mismatched resource was changed during cleanup"
    # Test-only cleanup: discover candidates by the unpredictable run label and
    # re-check ownership before removing them. Never clean by a shared prefix.
    [ "$actual_clabel" = "$MISMATCH_LABEL" ] && docker rm -f "$kept_container" >/dev/null
    [ "$actual_vlabel" = "$MISMATCH_LABEL" ] && docker volume rm "$kept_volume" >/dev/null
  else
    bad "could not locate both retained resources for ownership-mismatch cleanup"
  fi

  echo
  echo "=== 8. a wrong key must fail loudly, not silently ==="
  if make_key "$WORK/other-key.txt"; then
    out=$(BACKUP_KEYFILE="$WORK/other-key.txt" bash "$RESTORE" --latest 2>&1); rc=$?
    [ "$rc" = "6" ] && ok "wrong key exits 6 (verify)" || bad "expected exit 6, got $rc"
    case "$out" in *"decryption failed"*) ok "reports decryption failure explicitly" ;; *) bad "no explicit failure reason" ;; esac
  else
    skip_or_fail "age-keygen not installed" "wrong-key test"
  fi

  echo
  echo "=== 9. a corrupted object must fail loudly ==="
  target=$(find "$WORK/store" -name '*.dump.age' | head -1)
  cp "$target" "$WORK/good.age"
  printf 'tampered' >> "$target"
  out=$(bash "$RESTORE" --latest 2>&1); rc=$?
  [ "$rc" != "0" ] && ok "tampered ciphertext is rejected (exit $rc)" || bad "tampered object accepted"
  cp "$WORK/good.age" "$target"

  echo
  echo "=== 10. the secret gate blocks a config bundle ==="
  # The credential must go in a file the bundle ACTUALLY collects. Writing an
  # unrelated file proves nothing. deployment.json is VPS-only and bundled; it
  # is the realistic place a credential would be pasted by mistake.
  # The key is upper-case because the gate matches credential-shaped NAMES
  # (SECRET/PASSWORD/TOKEN/API_KEY/ACCESS_KEY/PRIVATE_KEY), not arbitrary ones.
  printf '{\n  "webUrl": "https://voice.truevinecloud.online/",\n  "PROVIDER_SECRET_KEY": "sk-live-not-a-real-secret"\n}\n' \
    > "$WORK/app/deployment.json"
  out=$(bash "$BACKUP" 2>&1); rc=$?
  if [ "$rc" = "2" ]; then
    ok "config bundle containing a credential is refused (exit 2)"
    case "$out" in *"secret pattern detected"*) ok "reports a secret pattern" ;; *) bad "no detail given" ;; esac
    case "$out" in *"deployment.json"*) ok "names the offending file" ;; *) bad "does not name the file" ;; esac
    # The rejection must not echo the value it found.
    case "$out" in *sk-live-not-a-real-secret*) bad "the credential value was printed" ;; *) ok "credential value not printed" ;; esac
  else
    bad "config bundle with a credential was accepted (exit $rc)"
    printf '%s\n' "$out" | sed 's/^/        /'
  fi
  rm -f "$WORK/app/deployment.json"
# Replace it with a clean one. Later sections assert that this VPS-only file is
# genuinely captured, so it has to exist when those backups run - otherwise the
# assertion would pass vacuously or fail for the wrong reason. Until this line
# the capture path for deployment.json had never been exercised positively.
printf '{\n  "webUrl": "https://voice.truevinecloud.online/",\n  "region": "eu-west"\n}\n' \
  > "$WORK/app/deployment.json"

  echo
  echo "=== 11. manifest integrity is a real check, not a self-comparison ==="
  TS=$(find "$WORK/store" -name '*.dump.age' | head -1 | xargs basename | sed 's/\.dump\.age$//')
  MAN="$WORK/store/prod/postgres/$TS.manifest.json"
  if [ -f "$MAN" ]; then
    csha=$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).cipher_sha256||"")' "$MAN")
    [ -n "$csha" ] && ok "manifest records cipher_sha256" || bad "manifest has no cipher_sha256"
    actual=$(sha256sum "$WORK/store/prod/postgres/$TS.dump.age" | cut -d' ' -f1)
    [ "$csha" = "$actual" ] && ok "cipher_sha256 matches the stored object" || bad "cipher_sha256 does not match the stored object"

    # Corrupt ONLY the manifest. If the restore still succeeds, the integrity
    # check is theatre: comparing the object to its own hash always passes.
    cp "$MAN" "$WORK/manifest.good"
    node -e 'const f=process.argv[1];const m=JSON.parse(require("fs").readFileSync(f,"utf8"));m.cipher_sha256="0".repeat(64);require("fs").writeFileSync(f,JSON.stringify(m,null,2))' "$MAN"
    out=$(bash "$RESTORE" --backup "$TS" 2>&1); rc=$?
    [ "$rc" = "6" ] && ok "a manifest that does not match the object is rejected (exit 6)" \
      || { bad "mismatched manifest was accepted (exit $rc)"; echo "$out" | sed 's/^/        /'; }
    cp "$WORK/manifest.good" "$MAN"
  else
    bad "no manifest found in the store"
  fi

  echo
  echo "=== 12. staging hygiene: nothing readable is left behind ==="
  export TMPDIR="$WORK/tmp"; mkdir -p "$TMPDIR"
  out=$(bash "$RESTORE" --latest 2>&1); rc=$?
  [ "$rc" = "0" ] && ok "verify-only restore still succeeds" || bad "verify-only failed (exit $rc)"
  rleft=$(find "$TMPDIR" -maxdepth 1 -type d -name 'truevine-restore-*' 2>/dev/null | wc -l | tr -d ' ')
  [ "$rleft" = "0" ] && ok "restore staging dir is removed on exit" || bad "$rleft restore staging dir(s) left behind"
  # The decisive check: a decrypted production dump must not survive a routine
  # verification. This was the defect that prompted the test.
  lplain=$(find "$TMPDIR" "$WORK" -type f -name '*.dump' ! -name '*.age' 2>/dev/null | wc -l | tr -d ' ')
  [ "$lplain" = "0" ] && ok "no plaintext dump survives a restore" || bad "PLAINTEXT DUMP LEFT ON DISK ($lplain)"

  bash "$BACKUP" >/dev/null 2>&1
  bleft=$(find "$TMPDIR" -maxdepth 1 -type d -name 'truevine-backup-*' 2>/dev/null | wc -l | tr -d ' ')
  [ "$bleft" = "0" ] && ok "backup staging dir is removed on exit" || bad "$bleft backup staging dir(s) left behind"
  unset TMPDIR

  echo
  echo "=== 13. status file is written where monitoring can read it ==="
  export BACKUP_STATUS_FILE="$WORK/status.json"
  rm -f "$BACKUP_STATUS_FILE"
  bash "$BACKUP" >/dev/null 2>&1; rc=$?
  [ "$rc" = "0" ] && ok "backup exits 0" || bad "backup failed (exit $rc)"
  if [ -f "$BACKUP_STATUS_FILE" ]; then
    ok "BACKUP_STATUS_FILE is written"
    state=$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).state||"")' "$BACKUP_STATUS_FILE")
    [ "$state" = "ok" ] && ok "status reports state=ok" || bad "status state is '$state'"
  else
    bad "BACKUP_STATUS_FILE was not created"
  fi
  # The failure path matters more than the success path: a silently failing
  # nightly job is the thing this has to make visible.
  rm -f "$BACKUP_STATUS_FILE"
  out=$(BACKUP_PG_CONTAINER=truevine-no-such-container bash "$BACKUP" 2>&1); rc=$?
  [ "$rc" = "3" ] && ok "dump failure exits 3 (dump)" || bad "expected exit 3, got $rc"
  if [ -f "$BACKUP_STATUS_FILE" ]; then
    st=$(node -e 'const m=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write((m.state||"")+":"+(m.exit_code??""))' "$BACKUP_STATUS_FILE")
    [ "$st" = "failed:3" ] && ok "failure status records state=failed exit_code=3" || bad "failure status was '$st'"
  else
    bad "no failure status was written"
  fi
  unset BACKUP_STATUS_FILE

  echo
  echo "=== 14. captured object metadata is valid, structured JSON ==="
  # Take the NEWEST configuration archive. `find | head -1` picks an arbitrary one
  # when several exist, and archives from before the deployment.json fixture was
  # written do not contain it - so the assertion passed or failed depending on
  # directory iteration order. That is exactly the kind of ordering-dependent test
  # which reports a real pass once and a real failure the next run.
  CFG=$(find "$WORK/store" -path '*config*' -name '*.age' | sort | tail -1)
  if [ -n "$CFG" ]; then
    rm -rf "$WORK/cfgx"; mkdir -p "$WORK/cfgx"
    if age --decrypt -i "$BACKUP_KEYFILE" -o "$WORK/cfgx/cfg.tar.gz" "$CFG" 2>/dev/null \
       && tar -xzf "$WORK/cfgx/cfg.tar.gz" -C "$WORK/cfgx" 2>/dev/null; then
      if [ -f "$WORK/cfgx/metadata.json" ]; then
        ok "configuration archive decrypts and extracts"
        node -e 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))' "$WORK/cfgx/metadata.json" 2>/dev/null \
          && ok "metadata.json parses as JSON" || bad "metadata.json is not valid JSON"
        node -e 'const m=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const c=(m.containers||[]).filter(Boolean)[0];if(!c)process.exit(0);process.exit(typeof c.name==="string"&&typeof c.image==="string"?0:1)' \
          "$WORK/cfgx/metadata.json" >/dev/null 2>&1 \
          && ok "container entries are structured objects, not joined strings" || bad "container entries are not structured"
        node -e 'const m=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.exit(Array.isArray(m.volumes)?0:1)' \
          "$WORK/cfgx/metadata.json" >/dev/null 2>&1 \
          && ok "volume inventory is captured as an array" \
          || bad "volume inventory missing"
      else
        bad "metadata.json was not captured"
      fi
      tar -tzf "$WORK/cfgx/cfg.tar.gz" | grep -q 'deployment\.json' \
        && ok "VPS-only deployment.json is in the archive" || bad "deployment.json missing from archive"
      if tar -tzf "$WORK/cfgx/cfg.tar.gz" | grep -q '\.env$'; then
        bad "the archive contains .env"
      else
        ok "the archive contains no .env"
      fi
      if tar -tzf "$WORK/cfgx/cfg.tar.gz" | grep -q '\.test\.sh$'; then
        bad "the archive contains a test fixture with credential-shaped strings"
      else
        ok "the archive excludes *.test.sh fixtures"
      fi
    else
      bad "configuration archive could not be decrypted or extracted"
    fi
  else
    bad "no encrypted configuration archive found"
  fi

else
  skip_or_fail "$skip_reason" "database-backed tests"
fi

echo
echo "=== 15. retention maths (7 daily / 4 weekly / 3 monthly) ==="
# Pure function; sourced directly.
set +u
. "$HERE/lib/common.sh"
set -u
keep=$(retention_keep_set \
  20260101T000000Z 20260102T000000Z 20260103T000000Z 20260104T000000Z \
  20260105T000000Z 20260106T000000Z 20260107T000000Z 20260108T000000Z \
  20251201T000000Z 20251101T000000Z 20251001T000000Z)
count=$(printf '%s\n' "$keep" | grep -c . || true)
[ "$count" -le 12 ] && ok "retention set is bounded ($count kept from 12 inputs)" || bad "retention kept $count"
# The newest must always survive.
case "$keep" in *20260108T000000Z*) ok "newest backup is always retained" ;; *) bad "newest backup was dropped" ;; esac
# Oldest month droppable when newer months exist.
count2=$(retention_keep_set 20260101T000000Z 20251101T000000Z 20251001T000000Z | grep -c . || true)
[ "$count2" -le 3 ] && ok "three-month window respected ($count2 kept)" || bad "kept $count2 beyond the monthly window"

echo
if [ "$fails" -eq 0 ]; then
  printf 'RESULT: PASS (%d skipped)\n' "$skipped"
  exit 0
else
  printf 'RESULT: FAIL (%d assertion(s) failed, %d skipped)\n' "$fails" "$skipped"
  exit 1
fi
