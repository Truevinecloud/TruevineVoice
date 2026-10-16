#!/usr/bin/env bash
#
# Truevine Voice — nightly encrypted PostgreSQL backup.
#
#   pg_dump  ->  age-encrypt on this host  ->  upload ciphertext only
#
# Also captures essential configuration and object metadata, gated by a
# secret-pattern check so a credential can never reach the bucket.
#
# This script only ever READS the production database. It never restores,
# migrates, stops or modifies anything.
#
# Required environment:
#   BACKUP_KEYFILE   path to an age identity file (mode 600)
#   BACKUP_STORE     s3 | local
#   BACKUP_BUCKET    bucket name                     (BACKUP_STORE=s3)
#   BACKUP_LOCAL_DIR directory simulating the bucket (BACKUP_STORE=local)
#
# Optional:
#   BACKUP_S3_ENDPOINT    custom S3 endpoint (MinIO and other S3-compatible)
#   BACKUP_LOG_FILE       append the log here as well as stderr
#   BACKUP_STATUS_FILE    machine-readable run status (state, exit_code).
#                         Monitoring reads this after the run. Without it the
#                         status goes to the staging directory, which is deleted
#                         on exit and is useful for debugging only.
#   BACKUP_WORK_DIR       staging directory (a mktemp dir by default). A
#                         directory created here is removed on exit; one you
#                         supply yourself is left alone.
#   BACKUP_PG_CONTAINER   container running PostgreSQL (default truevine-postgres)
#   BACKUP_CONFIG_SOURCE   directory holding configuration to capture
#   BACKUP_APP_ROOT        application root (default /var/www/TruevineVoice)
#
# Exit codes: 0 ok, 1 usage, 2 precondition, 3 dump, 4 encrypt, 5 upload, 6 verify
#
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=lib/common.sh
. "$HERE/lib/common.sh"

usage() {
  sed -n '3,26p' "$0" | sed 's/^# \{0,1\}//'
  exit "$EXIT_USAGE"
}

main() {
  [ $# -eq 0 ] || usage

  APP_ROOT="${BACKUP_APP_ROOT:-/var/www/TruevineVoice}"
  PG_CONTAINER="${BACKUP_PG_CONTAINER:-truevine-postgres}"
  PG_DB="${BACKUP_PG_DB:-truevine_voice}"
  PG_ROLE="${BACKUP_PG_ROLE:-truevine}"
  TIMESTAMP=$(date -u +%Y%m%dT%H%M%SZ)

  umask 077
  log "backup run starting"
  validate_config
  # A single EXIT handler: bash keeps only the last trap set for a signal, so
  # staging cleanup and failure reporting have to live in one function.
  trap on_exit EXIT
  log "store=$BACKUP_STORE recipient=$(redact "$BACKUP_RECIPIENT")"

  # ------------------------------------------------------------ 1. dump
  local dump="$BACKUP_WORK_DIR/$TIMESTAMP.dump"
  log "creating pg_dump of $PG_DB in $PG_CONTAINER"
  require_cmd docker
  if ! docker exec "$PG_CONTAINER" \
        pg_dump -U "$PG_ROLE" -d "$PG_DB" -Fc > "$dump"; then
    rm -f "$dump"
    die "$EXIT_DUMP" "pg_dump failed; no partial file left behind"
  fi
  [ -s "$dump" ] || { rm -f "$dump"; die "$EXIT_DUMP" "pg_dump produced an empty file"; }
  # A custom-format archive always starts with this magic. Catching it here
  # means a truncated or mis-routed file never reaches encryption.
  [ "$(head -c 5 "$dump")" = "PGDMP" ] \
    || { rm -f "$dump"; die "$EXIT_DUMP" "pg_dump output is not a custom-format archive"; }
  local dump_size dump_sha
  dump_size=$(stat -c %s "$dump")
  dump_sha=$(sha256_of "$dump")
  log "dump ok: ${dump_size} bytes, sha256 ${dump_sha:0:16}..."

  # ------------------------------------------------------------ 2. encrypt
  # Encryption happens here, on this host, before any upload. The bucket only
  # ever sees ciphertext.
  local cipher="$BACKUP_WORK_DIR/$TIMESTAMP.dump.age"
  log "encrypting"
  encrypt_stream "$cipher" < "$dump"
  local cipher_size cipher_sha
  cipher_size=$(stat -c %s "$cipher")
  cipher_sha=$(sha256_of "$cipher")
  log "ciphertext: ${cipher_size} bytes, sha256 ${cipher_sha:0:16}..."
  # The plaintext must not outlive the upload.
  rm -f "$dump"

  # ------------------------------------------------------------ 3. manifest
  # Written AFTER encryption so it can record the hash of the ciphertext that is
  # actually uploaded. Without that hash a restore has nothing to check the
  # downloaded object against, and "verification" degenerates into comparing a
  # file to itself.
  local manifest="$BACKUP_WORK_DIR/$TIMESTAMP.manifest.json"
  cat > "$manifest" <<JSON
{
  "timestamp": "$TIMESTAMP",
  "database": "$PG_DB",
  "container": "$PG_CONTAINER",
  "dump_bytes": $dump_size,
  "dump_sha256": "$dump_sha",
  "cipher_bytes": $cipher_size,
  "cipher_sha256": "$cipher_sha",
  "format": "PGDMP",
  "encrypted": true,
  "cipher": "age/ChaCha20-Poly1305",
  "recipient": "$BACKUP_RECIPIENT"
}
JSON

  # ------------------------------------------------------------ 4. upload
  local dump_key="$KEY_PREFIX/$TIMESTAMP.dump.age"
  local manifest_key="$KEY_PREFIX/$TIMESTAMP.manifest.json"
  log "uploading ciphertext and manifest"
  store_put "$cipher" "$dump_key"
  store_put "$manifest" "$manifest_key"
  # Prove the upload is readable and intact before declaring success. A backup
  # that uploaded truncated is not a backup. The comparison is against the
  # ciphertext we just produced, not against the copy we downloaded.
  log "verifying the uploaded object"
  local roundtrip="$BACKUP_WORK_DIR/roundtrip.age"
  store_get "$dump_key" "$roundtrip"
  verify_sha256 "$roundtrip" "$cipher_sha"
  rm -f "$roundtrip"

  # ------------------------------------------------------------ 5. config
  capture_configuration

  # ------------------------------------------------------------ 6. status
  write_status "$TIMESTAMP" "$dump_size" "$cipher_size" "$dump_sha" ok
  log "backup run completed for $TIMESTAMP"
}

# Captures essential configuration and object metadata.
#
# Deliberately EXCLUDES `.env`, SSH material, PM2 dumps and release directories:
# those hold credentials or are large and regenerable. The secret gate is the
# backstop in case a "safe" file stops being safe.
capture_configuration() {
  local src="${BACKUP_CONFIG_SOURCE:-$APP_ROOT}"
  local bundle="$BACKUP_WORK_DIR/config"
  rm -rf "$bundle"; mkdir -p "$bundle"

  # Explicit allow-list. Files not named here are never collected, which is a
  # stronger guarantee than filtering afterwards.
  #
  # The selection rule is: capture what exists ONLY on this host.
  #
  # EXCLUDED deliberately:
  #   .env              holds the live DATABASE_URL and REDIS_URL
  #   .env.example      public placeholder text; its DSN trips the secret gate
  #   docker-compose.yml, infrastructure/**  all tracked in git, so GitHub is
  #                     already an off-server copy. docker-compose.yml also
  #                     carries a committed POSTGRES_PASSWORD, so bundling it
  #                     would make the secret gate fail every single night.
  #   *.test.sh         test fixtures deliberately contain credential-shaped
  #                     strings, which the gate would then correctly reject
  local rel
  for rel in deployment.json; do
    [ -f "$src/$rel" ] || continue
    mkdir -p "$bundle/$(dirname "$rel")"
    cp "$src/$rel" "$bundle/$rel"
  done
  if [ -d "$src/infrastructure/backup" ]; then
    mkdir -p "$bundle/infrastructure/backup/lib"
    local s
    for s in "$src"/infrastructure/backup/*.sh; do
      case "$s" in *.test.sh) continue ;; esac
      cp "$s" "$bundle/infrastructure/backup/" 2>/dev/null || true
    done
    cp "$src"/infrastructure/backup/lib/*.sh "$bundle/infrastructure/backup/lib/" 2>/dev/null || true
    cp "$src"/infrastructure/backup/README.md "$bundle/infrastructure/backup/README.md" 2>/dev/null || true
  fi

  # Object metadata: what is running, and how it is wired. Names, ids, images,
  # mounts and networks only - no environment values, which is what keeps the
  # secret gate below green.
  #
  # Emitted as structured JSON objects rather than pipe-joined strings, so the
  # archive is actually usable when rebuilding a host from scratch.
  if command -v docker >/dev/null 2>&1; then
    {
      echo "{"
      echo -n '  "captured_at": "'"$(date -u +%Y-%m-%dT%H:%M:%SZ)"'",'
      echo -n '  "containers": ['
      local first=1 c
      for c in $(docker ps -a --format '{{.Names}}' | sort); do
        docker inspect "$c" 2>/dev/null \
          | node -e '
              let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
                const i=JSON.parse(s)[0];
                process.stdout.write(JSON.stringify({
                  name: i.Name.replace(/^\//,""),
                  image: i.Config.Image,
                  running: i.State.Running,
                  restart_policy: i.HostConfig.RestartPolicy.Name,
                  mounts: i.Mounts.map(m=>`${m.Type}:${m.Name||m.Source}`),
                }));
              });' || continue
        [ $first -eq 1 ] || echo -n ','
        first=0
      done
      echo '],'
      echo -n '  "volumes": ['
      first=1
      local v
      for v in $(docker volume ls -q | sort); do
        docker volume inspect "$v" 2>/dev/null \
          | node -e '
              let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
                const v=JSON.parse(s)[0];
                process.stdout.write(JSON.stringify({name:v.Name,driver:v.Driver,mountpoint:v.Mountpoint}));
              });' || continue
        [ $first -eq 1 ] || echo -n ','
        first=0
      done
      echo '],'
      echo -n '  "published_ports": ['
      first=1
      for c in $(docker ps --format '{{.Names}}' | sort); do
        local ports; ports=$(docker port "$c" 2>/dev/null | tr '\n' ' ' | sed 's/ *$//')
        [ -n "$ports" ] || continue
        [ $first -eq 1 ] || echo -n ','
        first=0
        printf '{"container":"%s","ports":"%s"}' "$c" "$ports"
      done
      echo ']'
      echo "}"
    } > "$bundle/metadata.json" 2>/dev/null || echo '{}' > "$bundle/metadata.json"
    # A malformed object inventory is a failed capture, not a warning: record it
    # so a restore review can see that the metadata is absent rather than trust
    # a silently-truncated file.
    node -e 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))' "$bundle/metadata.json" \
      || { warn "object metadata is not valid JSON; recording an empty inventory"; echo '{}' > "$bundle/metadata.json"; }
  fi

  # Defence in depth. The archive is encrypted below, so the bucket never sees
  # plaintext regardless; this gate exists so that a NEW credential appearing
  # in this bundle stops the run for a human to review, rather than being
  # silently shipped off-box under encryption.
  assert_no_secrets "$bundle"

  local stamp archive cipher
  stamp=$(date -u +%Y%m%dT%H%M%SZ)
  archive="$BACKUP_WORK_DIR/config-$stamp.tar.gz"
  cipher="$BACKUP_WORK_DIR/config-$stamp.tar.gz.age"
  tar -czf "$archive" -C "$bundle" .

  # Same rule as the database dump: encrypt on this host before any egress.
  encrypt_stream "$cipher" < "$archive"
  rm -f "$archive"

  store_put "$cipher" "$CONFIG_PREFIX/$(basename "$cipher")"
  log "configuration and metadata uploaded encrypted ($(stat -c %s "$cipher") bytes)"
  rm -rf "$bundle" "$cipher"
}

# Writes a machine-readable run status.
#
# BACKUP_STATUS_FILE is the real destination: monitoring reads it after the run.
# Without it the status is written into the staging directory, which exists only
# for the duration of the run and is then deleted - so it is useful for debugging
# a live run and nothing else. An earlier version wrote there unconditionally,
# which produced a file that looked like a status channel and was read by nobody.
write_status() {
  local ts=$1 dump_bytes=$2 cipher_bytes=$3 sha=$4 state=$5 exit_code=${6:-0}
  local target="${BACKUP_STATUS_FILE:-$BACKUP_WORK_DIR/status.json}"
  cat > "$target" <<JSON
{
  "timestamp": "$ts",
  "state": "$state",
  "exit_code": $exit_code,
  "dump_bytes": $dump_bytes,
  "cipher_bytes": $cipher_bytes,
  "dump_sha256": "$sha",
  "store": "$BACKUP_STORE"
}
JSON
  [ -n "${BACKUP_STATUS_FILE:-}" ] && chmod 600 "$target" 2>/dev/null || true
  log "status recorded: $ts $state -> $target"
}

# Records a failed run on the way out, so a monitoring job that only reads the
# status file still learns that the nightly backup did not succeed.
#
# Combined with staging cleanup in one handler: bash retains only the last trap
# registered for a signal, so registering cleanup and reporting separately would
# silently disable whichever was set first.
on_exit() {
  local rc=$?
  release_work_dir
  if [ "$rc" -ne 0 ] && [ -n "${BACKUP_STATUS_FILE:-}" ]; then
    write_status "${TIMESTAMP:-unknown}" 0 0 "" failed "$rc" 2>/dev/null || true
  fi
  return "$rc"
}

main "$@"