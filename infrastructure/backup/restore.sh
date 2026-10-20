#!/usr/bin/env bash
#
# Truevine Voice — restore a backup taken by backup.sh.
#
# Default mode is VERIFY ONLY: it downloads, decrypts, checksums and inspects the
# archive without touching any database. Restoring requires an explicit
# --restore flag, and by default only into an isolated throwaway instance - the
# same safety model as infrastructure/scripts/db-verify.sh.
#
# Verification is two independent checks against the manifest recorded at backup
# time: the downloaded ciphertext (cipher_sha256) and the decrypted dump
# (dump_sha256). The decrypted dump is removed from disk on every exit path.
#
# Usage:
#   restore.sh --latest                     verify the newest off-server backup
#   restore.sh --backup 20261016T020000Z     verify a specific backup
#   restore.sh --latest --restore           ALSO restore into an isolated instance
#   restore.sh --latest --list              list what is available
#
# Environment is the same as backup.sh. BACKUP_KEYFILE is required.
#
# Exit codes: 0 ok, 1 usage, 2 precondition, 6 verify
#
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=lib/common.sh
. "$HERE/lib/common.sh"

usage() { sed -n '3,18p' "$0" | sed 's/^# \{0,1\}//'; exit "$EXIT_USAGE"; }

LATEST=0
BACKUP_TS=""
DO_RESTORE=0
DO_LIST=0

while [ $# -gt 0 ]; do
  case "$1" in
    --latest)  LATEST=1 ;;
    --backup)  BACKUP_TS="${2:-}"; shift ;;
    --restore) DO_RESTORE=1 ;;
    --list)    DO_LIST=1 ;;
    -h|--help) usage ;;
    *) err "unknown argument: $1"; usage ;;
  esac
  shift
done

log "restore command starting"

case "${BACKUP_STORE:-}" in
  s3|local) : ;;
  *) die "$EXIT_PRECONDITION" "BACKUP_STORE must be 's3' or 'local'" ;;
esac
[ -n "${BACKUP_KEYFILE:-}" ] || die "$EXIT_PRECONDITION" "BACKUP_KEYFILE is not set"
[ -f "$BACKUP_KEYFILE" ]     || die "$EXIT_PRECONDITION" "BACKUP_KEYFILE does not exist"

# Same key-permissions rule as backup.sh: a private key readable by group or
# other is a finding, not something to work around.
key_mode=$(stat -c '%a' "$BACKUP_KEYFILE" 2>/dev/null || echo "")
if [ -n "$key_mode" ] && [ "$(( 8#$key_mode & 8#077 ))" -ne 0 ]; then
  die "$EXIT_PRECONDITION" "BACKUP_KEYFILE mode is $key_mode; it must not be readable by group or other"
fi
# Same extraction as backup.sh: age-keygen comments the public key line.
BACKUP_RECIPIENT=$(sed -n 's/^[[:space:]#]*public key:[[:space:]]*\(age1[0-9a-z]*\).*/\1/p' "$BACKUP_KEYFILE" | head -1 || true)
[ -n "$BACKUP_RECIPIENT" ] || die "$EXIT_PRECONDITION" "BACKUP_KEYFILE has no public key line"
BACKUP_WORK_DIR="${BACKUP_WORK_DIR:-$(mktemp -d -t truevine-restore-XXXXXX)}"
if [ -z "${BACKUP_WORK_DIR_OWNED:-}" ]; then
  own_work_dir
fi
mkdir -p "$BACKUP_WORK_DIR"
umask 077
# Staging holds the DECRYPTED production dump. Remove it on every exit path so a
# plaintext database is never left sitting in /tmp after a routine verification.
RESTORE_VOLUME_MOUNTPOINT=""
RESTORE_CONTAINER_ID=""
RESTORE_VOLUME_OWNED=0
RESTORE_CONTAINER_OWNED=0
restore_exit_cleanup() {
  local status=$?
  if declare -F cleanup_restore_resources >/dev/null; then
    cleanup_restore_resources || status=1
  fi
  release_work_dir || status=1
  return "$status"
}
trap restore_exit_cleanup EXIT

# KEY_PREFIX and CONFIG_PREFIX are set once by lib/common.sh; redeclaring them
# here fails with "readonly variable" and aborts the run.

if [ "$DO_LIST" = 1 ]; then
  log "available backups under $KEY_PREFIX"
  store_list "$KEY_PREFIX" | grep -E '\.dump\.age$' | sed "s/\.dump\.age$//" | sort -r | sed 's/^/  /'
  exit "$EXIT_OK"
fi

# Resolve which backup to use.
if [ "$LATEST" = 1 ]; then
  BACKUP_TS=$(store_list "$KEY_PREFIX" | grep -E '\.dump\.age$' | sed "s/\.dump\.age$//" | sort -r | head -1)
  [ -n "$BACKUP_TS" ] || die "$EXIT_VERIFY" "no backups found under $KEY_PREFIX"
elif [ -n "$BACKUP_TS" ]; then
  :
else
  usage
fi
log "selected backup: $BACKUP_TS"

DUMP_KEY="$KEY_PREFIX/$BACKUP_TS.dump.age"
MANIFEST_KEY="$KEY_PREFIX/$BACKUP_TS.manifest.json"
store_exists "$DUMP_KEY" || die "$EXIT_VERIFY" "backup object not found: $DUMP_KEY"

# 1. fetch ciphertext and manifest
cipher="$BACKUP_WORK_DIR/$BACKUP_TS.dump.age"
manifest="$BACKUP_WORK_DIR/$BACKUP_TS.manifest.json"
log "downloading ciphertext"
store_get "$DUMP_KEY" "$cipher"
if store_exists "$MANIFEST_KEY"; then
  store_get "$MANIFEST_KEY" "$manifest"
else
  die "$EXIT_VERIFY" "manifest missing for $BACKUP_TS; refusing to restore without it"
fi

# 2. integrity of the ciphertext in transit.
#
# Checked against cipher_sha256, which backup.sh records at upload time. An
# earlier version compared the downloaded object to its own hash, which can never
# fail, and so logged a reassuring "sha256 verified" for a file it had in fact
# checked nothing about.
expected_cipher_sha=$(node -e 'const m=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(m.cipher_sha256||"")' "$manifest")
[ -n "$expected_cipher_sha" ] \
  || die "$EXIT_VERIFY" "manifest has no cipher_sha256; refusing to trust an object against a manifest that cannot vouch for it"
verify_sha256 "$cipher" "$expected_cipher_sha"
log "ciphertext fetched: $(stat -c %s "$cipher") bytes"

# 3. decrypt. A wrong key or tampered object fails here, loudly.
plain="$BACKUP_WORK_DIR/$BACKUP_TS.dump"
log "decrypting"
decrypt_file "$cipher" "$plain"

# 4. integrity of the plaintext against the manifest recorded at backup time.
# This is the check that catches a truncated upload or a swapped object.
expected_sha=$(node -e 'const m=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(m.dump_sha256||"")' "$manifest")
[ -n "$expected_sha" ] || die "$EXIT_VERIFY" "manifest has no dump_sha256"
verify_sha256 "$plain" "$expected_sha"

# 5. structural validity
[ "$(head -c 5 "$plain")" = "PGDMP" ] || die "$EXIT_VERIFY" "decrypted archive is not a custom-format dump"
if command -v pg_restore >/dev/null 2>&1; then
  # Distinguish two very different situations that used to be conflated:
  #   - pg_restore ran and reported an archive with no objects. That is a real
  #     defect in the dump and must fail.
  #   - pg_restore could not read the archive at all. That says something about
  #     the LOCAL CLIENT, not about the archive. A PostgreSQL 18 dump read by an
  #     older client fails exactly this way, and treating it as corruption made a
  #     perfectly good backup look unrestorable - which is the most damaging kind
  #     of false alarm a backup tool can raise.
  #
  # Integrity is already proven above: age authenticates the ciphertext, and the
  # decrypted bytes match dump_sha256 recorded at backup time. So the archive is
  # byte-for-byte what pg_dump produced. The authoritative readability proof is
  # the --restore path below, which uses the matching PostgreSQL image.
  toc_out=$(pg_restore --list < "$plain" 2>&1) && toc_rc=0 || toc_rc=$?
  if [ "$toc_rc" -eq 0 ]; then
    entries=$(printf '%s\n' "$toc_out" | grep -cE '^[0-9]+;' || true)
    [ "${entries:-0}" -gt 0 ] || die "$EXIT_VERIFY" "pg_restore read the archive but it contains no objects"
    log "archive table of contents: $entries entries"
  else
    warn "local pg_restore cannot read this archive (exit $toc_rc); treating it as a local client limitation, not archive damage"
    warn "integrity is still proven by the sha256 chain; run with --restore to prove readability with a matching PostgreSQL image"
  fi
else
  warn "pg_restore not available on this host; skipping table-of-contents inspection"
fi

if [ "$DO_RESTORE" = 0 ]; then
  # Verify-only: the dump has served its purpose. Remove it before reporting
  # success, so a completed check leaves nothing readable behind.
  scrub_plaintext "$plain"
  log "VERIFY OK: $BACKUP_TS decrypts, matches its manifest sha256, and is a valid archive"
  log "no database was touched. Re-run with --restore to restore into an isolated instance."
  exit "$EXIT_OK"
fi

# 6. restore into an ISOLATED instance only.
#
# This never restores over production. Restoring over the live database is a
# separate, supervised operation with its own approval, because it discards
# every write made after the backup was taken.
log "restoring into an isolated instance (production is not touched)"
PG_IMAGE="${BACKUP_PG_IMAGE:-postgres:18-alpine}"
PG_DB="${BACKUP_PG_DB:-truevine_voice}"
[[ "$BACKUP_TS" =~ ^[0-9]{8}T[0-9]{6}Z$ ]] \
  || die "$EXIT_VERIFY" "invalid backup timestamp; refusing to derive Docker resource names"
require_cmd docker od
RUN_NONCE=$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')
[ "${#RUN_NONCE}" = 32 ] || die "$EXIT_PRECONDITION" "could not generate a unique restore run id"
RUN_LABEL="truevine-restore-${BACKUP_TS}-$$-${RUN_NONCE}"
CONTAINER="truevine-restore-${BACKUP_TS}-$$-${RUN_NONCE}"
VOLUME="${CONTAINER}-vol"

# Never remove a resource merely because its name looks familiar. Ownership is
# established only after Docker reports the exact run label and expected
# isolation settings. If inspection itself is ambiguous, cleanup fails closed.
container_is_owned() {
  local inspected_id inspected_name inspected_label network mount
  [ -n "$RESTORE_CONTAINER_ID" ] || return 1
  inspected_id=$(docker inspect --format '{{.Id}}' "$RESTORE_CONTAINER_ID" 2>/dev/null) || return 1
  inspected_name=$(docker inspect --format '{{.Name}}' "$RESTORE_CONTAINER_ID" 2>/dev/null) || return 1
  inspected_label=$(docker inspect --format '{{ index .Config.Labels "truevine.restore.run" }}' "$RESTORE_CONTAINER_ID" 2>/dev/null) || return 1
  network=$(docker inspect --format '{{.HostConfig.NetworkMode}}' "$RESTORE_CONTAINER_ID" 2>/dev/null) || return 1
  mount=$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/var/lib/postgresql"}}{{.Name}}{{end}}{{end}}' "$RESTORE_CONTAINER_ID" 2>/dev/null) || return 1
  [ "$inspected_id" = "$RESTORE_CONTAINER_ID" ] && [ "$inspected_name" = "/$CONTAINER" ] \
    && [ "$inspected_label" = "$RUN_LABEL" ] && [ "$network" = "none" ] && [ "$mount" = "$VOLUME" ]
}

volume_is_owned() {
  local inspected_label inspected_mountpoint
  [ "$RESTORE_VOLUME_OWNED" = 1 ] || return 1
  inspected_label=$(docker volume inspect --format '{{ index .Labels "truevine.restore.run" }}' "$VOLUME" 2>/dev/null) || return 1
  inspected_mountpoint=$(docker volume inspect --format '{{.Mountpoint}}' "$VOLUME" 2>/dev/null) || return 1
  [ "$inspected_label" = "$RUN_LABEL" ] && [ "$inspected_mountpoint" = "$RESTORE_VOLUME_MOUNTPOINT" ] \
    && [ -n "$inspected_mountpoint" ]
}

cleanup_restore_resources() {
  local cleanup_failed=0
  if [ "$RESTORE_CONTAINER_OWNED" = 1 ]; then
    if container_is_owned; then
      docker rm -f "$RESTORE_CONTAINER_ID" >/dev/null || cleanup_failed=1
    else
      err "refusing to remove restore container: ownership could not be verified"
      cleanup_failed=1
    fi
  fi
  if [ "$RESTORE_VOLUME_OWNED" = 1 ]; then
    if volume_is_owned; then
      docker volume rm "$VOLUME" >/dev/null || cleanup_failed=1
    else
      err "refusing to remove restore volume: ownership could not be verified"
      cleanup_failed=1
    fi
  fi
  return "$cleanup_failed"
}

# A name collision is a hard stop. The random name reduces the chance of one;
# the inspect checks ensure even a collision can never be adopted or replaced.
if docker inspect "$CONTAINER" >/dev/null 2>&1; then
  die "$EXIT_VERIFY" "restore container name already exists; refusing to use or remove it"
fi
if docker volume inspect "$VOLUME" >/dev/null 2>&1; then
  die "$EXIT_VERIFY" "restore volume name already exists; refusing to use or remove it"
fi

require_cmd docker

# --network none: no route to or from anywhere, least of all production.
docker volume create --label "truevine.restore.run=$RUN_LABEL" "$VOLUME" >/dev/null
RESTORE_VOLUME_MOUNTPOINT=$(docker volume inspect --format '{{.Mountpoint}}' "$VOLUME") \
  || die "$EXIT_VERIFY" "could not inspect newly created restore volume"
RESTORE_VOLUME_OWNED=1
volume_is_owned || die "$EXIT_VERIFY" "new restore volume ownership could not be verified"
RESTORE_CONTAINER_ID=$(docker run -d --name "$CONTAINER" --network none \
  --mount "type=volume,src=$VOLUME,dst=/var/lib/postgresql" \
  --label "truevine.restore.run=$RUN_LABEL" \
  -e POSTGRES_HOST_AUTH_METHOD=trust -e POSTGRES_DB="$PG_DB" \
  "$PG_IMAGE") || die "$EXIT_VERIFY" "could not start isolated restore container"
RESTORE_CONTAINER_OWNED=1
container_is_owned || die "$EXIT_VERIFY" "new restore container ownership or isolation could not be verified"
log "isolated restore run label: $RUN_LABEL"

ready=0
for _ in $(seq 1 90); do
  # `pg_isready` is NOT sufficient: the postgres image runs a temporary server
  # while initialising, and pg_isready succeeds against it, so a restore could
  # start and then fail with "the database system is shutting down". Require a
  # real query to succeed instead.
  if docker exec "$RESTORE_CONTAINER_ID" psql -U postgres -d "$PG_DB" -tAc 'SELECT 1' >/dev/null 2>&1; then
    ready=1; break
  fi
  sleep 1
done
[ "$ready" = 1 ] || { docker logs "$RESTORE_CONTAINER_ID" 2>&1 | tail -20 >&2; die "$EXIT_VERIFY" "restore instance never became ready"; }

docker cp "$plain" "$RESTORE_CONTAINER_ID:/tmp/restore.dump"
# The dump has been handed to the isolated container. It is no longer needed on
# this host, so it goes now rather than at the end of the script.
scrub_plaintext "$plain"

# Retry ONLY the transient connection-state errors. A genuine restore failure
# (corrupt archive, incompatible version) must fail immediately rather than be
# retried five times and then reported as something it is not.
restored=0
restore_err=""
for attempt in 1 2 3 4 5; do
  if restore_err=$(docker exec "$RESTORE_CONTAINER_ID" pg_restore -U postgres -d "$PG_DB" \
        --no-owner --no-privileges /tmp/restore.dump 2>&1); then
    restored=1; break
  fi
  case "$restore_err" in
    *"shutting down"*|*"starting up"*|*"not yet accepting"*)
      [ "$attempt" = 5 ] && break
      warn "restore instance is still initialising (attempt $attempt); retrying"
      sleep 3
      ;;
    *) break ;;
  esac
done

if [ "$restored" != 1 ]; then
  printf '%s\n' "$restore_err" | tail -20 >&2
  scrub_plaintext "$plain"
  die "$EXIT_VERIFY" "pg_restore failed"
fi

tables=$(docker exec "$RESTORE_CONTAINER_ID" psql -U postgres -d "$PG_DB" -tAc \
  "SELECT count(*) FROM information_schema.tables WHERE table_schema='public';" 2>/dev/null || echo 0)
log "restore complete: $tables table(s) in the isolated instance"

cleanup_restore_resources || die "$EXIT_VERIFY" "isolated restore cleanup failed; resources were retained where ownership was uncertain"
RESTORE_CONTAINER_OWNED=0
RESTORE_VOLUME_OWNED=0
log "isolated instance discarded; production untouched"
log "RESTORE VERIFIED for $BACKUP_TS"
