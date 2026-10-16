#!/usr/bin/env bash
#
# Truevine Voice — shared backup library.
#
# Sourced by backup.sh and restore.sh. Contains no side effects beyond defining
# functions; each script decides what to call.
#
# Design rules that the tests enforce:
#  - Encryption happens on the VPS, before any network egress. Only ciphertext
#    is ever handed to the storage backend.
#  - Nothing secret is ever written to a log, to stdout, or to a bucket. A
#    secret-pattern gate aborts the run rather than uploading a config bundle
#    that happens to contain a credential.
#  - Every command's exit status is checked. A backup that silently half-succeeds
#    is worse than no backup.
#
set -euo pipefail

# Exit codes are part of the contract; monitoring distinguishes them.
readonly EXIT_OK=0
readonly EXIT_USAGE=1
readonly EXIT_PRECONDITION=2
readonly EXIT_DUMP=3
readonly EXIT_ENCRYPT=4
readonly EXIT_UPLOAD=5
readonly EXIT_VERIFY=6

# Retention: 7 daily, 4 weekly, 3 monthly.
readonly KEEP_DAILY=7
readonly KEEP_WEEKLY=4
readonly KEEP_MONTHLY=3

# Object keys live under one prefix so the bucket credential can be scoped to it.
readonly KEY_PREFIX="${BACKUP_KEY_PREFIX:-prod/postgres}"
readonly CONFIG_PREFIX="${BACKUP_CONFIG_PREFIX:-prod/config}"

# ---------------------------------------------------------------- logging

# Patterns that must never appear in output. Applied to every log line, so a
# careless `echo` elsewhere cannot leak a key or a DSN.
readonly REDACTIONS='s#(AGE-SECRET-KEY-1)[A-Z0-9]+#\1<redacted>#g;
                      s#(age-secret-key-1)[a-z0-9]+#\1<redacted>#g;
                      s#(AGE-SECRET-KEY-1)[A-Z0-9]+#\1<redacted>#g;
                      s#age1[0-9a-z]{20,}#age1<redacted>#g;
                      s#(postgres(ql)?|redis)://[^ ]*#\1://<redacted>#g;
                      s#([Pp][Aa][Ss][Ss][Ww][Oo][Rr][Dd])=[^ ]*#\1=<redacted>#g;
                      s#([Ss][Ee][Cc][Rr][Ee][Tt])=[^ ]*#\1=<redacted>#g;
                      s#([Tt][Oo][Kk][Ee][Nn])=[^ ]*#\1=<redacted>#g'

redact() { printf '%s' "$*" | sed -E "$REDACTIONS"; }

_log() {
  local level=$1; shift
  local line
  line="$(redact "$(date -u +%Y-%m-%dT%H:%M:%SZ) [$level] $*")"
  printf '%s\n' "$line" >&2
  [ -n "${BACKUP_LOG_FILE:-}" ] && printf '%s\n' "$line" >> "$BACKUP_LOG_FILE" || true
}
log()  { _log INFO  "$*"; }
warn() { _log WARN  "$*"; }
err()  { _log ERROR "$*"; }

# die <exit-code> <message...>
die() {
  local code=$1; shift
  err "$*"
  exit "$code"
}

# ---------------------------------------------------------------- preconditions

require_cmd() {
  local c
  for c in "$@"; do
    command -v "$c" >/dev/null 2>&1 || die "$EXIT_PRECONDITION" "required command not found: $c"
  done
}

# Validates configuration and exits before touching anything if it is wrong.
validate_config() {
  [ -n "${BACKUP_KEYFILE:-}" ] || die "$EXIT_PRECONDITION" "BACKUP_KEYFILE is not set"
  [ -f "$BACKUP_KEYFILE" ]     || die "$EXIT_PRECONDITION" "BACKUP_KEYFILE does not exist: $BACKUP_KEYFILE"
  [ -r "$BACKUP_KEYFILE" ]     || die "$EXIT_PRECONDITION" "BACKUP_KEYFILE is not readable"
  local mode
  mode=$(stat -c '%a' "$BACKUP_KEYFILE" 2>/dev/null || echo "")
  # The private key must not be readable by group or other. A key file is only
  # ever read by root and the backup user.
  # `8#` is required: bash arithmetic rejects a C-style `0o` octal prefix, so
  # `$((0$mode & 0o077))` errors instead of comparing anything.
  if [ -n "$mode" ] && [ "$(( 8#$mode & 8#077 ))" -ne 0 ]; then
    die "$EXIT_PRECONDITION" "BACKUP_KEYFILE mode is $mode; it must not be readable by group or other"
  fi
  # `age-keygen` writes the public key as a COMMENTED line ("# public key: age1…"),
  # so anchoring on "^public key" never matches and, under `pipefail`, the empty
  # grep killed the script with an unexplained exit 1. The pattern tolerates the
  # leading '#', and `|| true` lets the explicit check below produce a proper
  # precondition failure instead.
  BACKUP_RECIPIENT=$(sed -n 's/^[[:space:]#]*public key:[[:space:]]*\(age1[0-9a-z]*\).*/\1/p' "$BACKUP_KEYFILE" | head -1 || true)
  [ -n "$BACKUP_RECIPIENT" ] || die "$EXIT_PRECONDITION" "BACKUP_KEYFILE has no public key line"

  case "${BACKUP_STORE:-}" in
    s3|local) : ;;
    *) die "$EXIT_PRECONDITION" "BACKUP_STORE must be 's3' or 'local' (got '${BACKUP_STORE:-unset}')" ;;
  esac
  if [ "${BACKUP_STORE:-}" = "s3" ]; then
    require_cmd aws
    [ -n "${BACKUP_BUCKET:-}" ] || die "$EXIT_PRECONDITION" "BACKUP_BUCKET is not set"
  else
    [ -n "${BACKUP_LOCAL_DIR:-}" ] || die "$EXIT_PRECONDITION" "BACKUP_LOCAL_DIR is not set"
    mkdir -p "$BACKUP_LOCAL_DIR"
  fi
  if [ -z "${BACKUP_WORK_DIR:-}" ]; then
    BACKUP_WORK_DIR=$(mktemp -d -t "truevine-backup-XXXXXX")
    own_work_dir
  fi
  mkdir -p "$BACKUP_WORK_DIR"
}

# ---------------------------------------------------------------- work dir
#
# Staging holds ciphertext and, during a restore, the DECRYPTED production dump.
# Leaving that behind means a plaintext database sitting in /tmp until someone
# notices, so an auto-created staging directory is always removed on exit.
#
# A caller-supplied BACKUP_WORK_DIR is never deleted: the caller may have pointed
# it somewhere specific and may want to inspect it. Those files are still removed
# explicitly by the scripts at the point they stop being needed.
BACKUP_WORK_DIR_OWNED=""

own_work_dir() {
  BACKUP_WORK_DIR_OWNED="$BACKUP_WORK_DIR"
}

release_work_dir() {
  [ -n "$BACKUP_WORK_DIR_OWNED" ] || return 0
  rm -rf "$BACKUP_WORK_DIR_OWNED"
  BACKUP_WORK_DIR_OWNED=""
}

# Removes a decrypted dump from disk. Called on every path that creates one.
scrub_plaintext() {
  local f=$1
  [ -n "$f" ] || return 0
  [ -e "$f" ] || return 0
  if shred -u "$f" 2>/dev/null; then
    log "plaintext removed (overwritten then unlinked): $(basename "$f")"
  else
    rm -f "$f"
    log "plaintext removed: $(basename "$f")"
  fi
}

# ---------------------------------------------------------------- integrity

sha256_of() { sha256sum "$1" | cut -d' ' -f1; }

verify_sha256() {
  local file=$1 expected=$2 actual
  actual=$(sha256_of "$file")
  [ "$actual" = "$expected" ] || die "$EXIT_VERIFY" "sha256 mismatch for $(basename "$file"): expected $expected got $actual"
  log "sha256 verified for $(basename "$file")"
}

# ---------------------------------------------------------------- encryption

# Encrypts stdin to the file named by the first argument.
encrypt_stream() {
  local out=$1
  require_cmd age
  if ! age -r "$BACKUP_RECIPIENT" -o "$out"; then
    rm -f "$out"
    die "$EXIT_ENCRYPT" "encryption failed; no ciphertext written"
  fi
  [ -s "$out" ] || die "$EXIT_ENCRYPT" "encryption produced an empty file"
}

decrypt_file() {
  local in=$1 out=$2
  require_cmd age
  # age authenticates its ciphertext. A wrong key or a tampered object fails
  # loudly here rather than yielding garbage that would later be restored.
  if ! age --decrypt -i "$BACKUP_KEYFILE" -o "$out" "$in"; then
    rm -f "$out"
    die "$EXIT_VERIFY" "decryption failed (wrong key, or the object is corrupt)"
  fi
  [ -s "$out" ] || die "$EXIT_VERIFY" "decryption produced an empty file"
}

# ---------------------------------------------------------------- secret gate

# Refuses to let a config bundle containing a credential reach the bucket.
#
# The bundle is assembled from known-safe files, but a file can change under us
# (someone pastes a credential into a compose file). This gate is the backstop.
assert_no_secrets() {
  local dir=$1
  require_cmd grep
  local hits
  # Three separate defects were found here by running the gate against real
  # input, not by reading it:
  #   `[=:]` not just `=`  - YAML uses "KEY: value", so POSTGRES_PASSWORD passed.
  #   `[[:space:]]*`       - YAML puts a SPACE after the colon; without it the
  #                          character class was required to match the space.
  #   `["']?`              - JSON keys are quoted, so a real credential in
  #                          deployment.json arrives as
  #                          "PROVIDER_SECRET_KEY": "sk-live-..." and matched
  #                          nothing without this.
  #
  # False positives are acceptable and intentional: a false positive stops the
  # run for a human to look, a false negative ships a secret. The bundle is
  # assembled from an allow-list of VPS-only files precisely so this gate does
  # not have to guess which credentials are harmless.
  hits=$(grep -rIlE \
      "(AGE-SECRET-KEY-1[A-Z0-9]+|BEGIN [A-Z ]*PRIVATE KEY|postgres(ql)?://[^ ]+:[^ ]+@|redis://[^ ]*:[^ ]*@|(PASSWORD|SECRET|TOKEN|API_KEY|ACCESS_KEY|PRIVATE_KEY)[A-Z_]*[\"']?[=:][[:space:]]*[^[:space:]]+)" \
      "$dir" 2>/dev/null || true)
  if [ -n "$hits" ]; then
    while read -r f; do
      err "secret pattern detected in config bundle file: ${f#$dir/}"
    done <<< "$hits"
    die "$EXIT_PRECONDITION" "config bundle contains a credential; refusing to upload"
  fi
  log "secret gate passed for config bundle"
}

# ---------------------------------------------------------------- storage

# store_put <local-file> <remote-key>
store_put() {
  local file=$1 key=$2
  case "$BACKUP_STORE" in
    local)
      mkdir -p "$BACKUP_LOCAL_DIR/$(dirname "$key")"
      cp "$file" "$BACKUP_LOCAL_DIR/$key" || die "$EXIT_UPLOAD" "local store: copy failed"
      ;;
    s3)
      local args=(s3 cp "$file" "s3://$BACKUP_BUCKET/$key" --only-show-errors)
      [ -n "${BACKUP_S3_ENDPOINT:-}" ] && args+=(--endpoint-url "$BACKUP_S3_ENDPOINT")
      aws "${args[@]}" || die "$EXIT_UPLOAD" "upload failed for $key"
      ;;
  esac
}

# store_get <remote-key> <local-file>
store_get() {
  local key=$1 file=$2
  case "$BACKUP_STORE" in
    local)
      [ -f "$BACKUP_LOCAL_DIR/$key" ] || die "$EXIT_VERIFY" "local store: object not found: $key"
      cp "$BACKUP_LOCAL_DIR/$key" "$file" || die "$EXIT_VERIFY" "local store: copy failed"
      ;;
    s3)
      local args=(s3 cp "s3://$BACKUP_BUCKET/$key" "$file" --only-show-errors)
      [ -n "${BACKUP_S3_ENDPOINT:-}" ] && args+=(--endpoint-url "$BACKUP_S3_ENDPOINT")
      aws "${args[@]}" || die "$EXIT_VERIFY" "download failed for $key"
      ;;
  esac
}

# store_exists <remote-key> -> 0 present, 1 absent
store_exists() {
  local key=$1
  case "$BACKUP_STORE" in
    local) [ -f "$BACKUP_LOCAL_DIR/$key" ] ;;
    s3)
      local args=(s3api head-object --bucket "$BACKUP_BUCKET" --key "$key")
      [ -n "${BACKUP_S3_ENDPOINT:-}" ] && args+=(--endpoint-url "$BACKUP_S3_ENDPOINT")
      aws "${args[@]}" >/dev/null 2>&1
      ;;
  esac
}

# store_list <prefix> -> one key per line
store_list() {
  local prefix=$1
  case "$BACKUP_STORE" in
    local)
      local d="$BACKUP_LOCAL_DIR/$prefix"
      [ -d "$d" ] || return 0
      ( cd "$BACKUP_LOCAL_DIR" && find "$prefix" -type f | sed "s#^$prefix/##" | sort )
      ;;
    s3)
      local args=(s3api list-objects-v2 --bucket "$BACKUP_BUCKET" --prefix "$prefix/")
      [ -n "${BACKUP_S3_ENDPOINT:-}" ] && args+=(--endpoint-url "$BACKUP_S3_ENDPOINT")
      aws "${args[@]}" | node -e '
        let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
          const prefix=process.argv[1];
          for(const o of (JSON.parse(s).Contents||[]))
            console.log(o.Key.replace(new RegExp("^"+prefix.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")+"/"),""));
        });' "$prefix"
      ;;
  esac
}

# ---------------------------------------------------------------- retention

# Classifies backup timestamps into the three retention tiers.
#
# A backup is retained if it is among the newest KEEP_DAILY days, the newest
# backup of one of the newest KEEP_WEEKLY ISO weeks, or the newest backup of one
# of the newest KEEP_MONTHLY months. Everything else is prunable.
#
# Prints, one per line, the timestamps that should be KEPT.
retention_keep_set() {
  printf '%s\n' "$@" | grep -E '^[0-9]{8}T[0-9]{6}Z$' | sort -r | node -e '
    let raw="";process.stdin.on("data",d=>raw+=d).on("end",()=>{
      const daily=Number(process.argv[1]), weekly=Number(process.argv[2]), monthly=Number(process.argv[3]);
      const ts=raw.trim().split("\n").filter(Boolean);
      const days=new Set(),weeks=new Set(),months=new Set();
      const keep=[];
      for(const t of ts){
        const d=new Date(Date.UTC(
          Number(t.slice(0,4)),Number(t.slice(4,6))-1,Number(t.slice(6,8)),
          Number(t.slice(9,11)),Number(t.slice(11,13)),Number(t.slice(13,15))));
        const day=d.toISOString().slice(0,10);
        const mon=d.toISOString().slice(0,7);
        // ISO week: Thursday of the current week fixes the year boundary.
        const th=new Date(d); th.setUTCDate(th.getUTCDate()+4-(th.getUTCDay()||7));
        const jan1=new Date(Date.UTC(th.getUTCFullYear(),0,1));
        const wk=th.getUTCFullYear()+"-W"+String(Math.ceil(((th-jan1)/86400000+1)/7)).padStart(2,"0");
        const hitDays=days.size<daily&&!days.has(day);
        const hitWeeks=weeks.size<weekly&&!weeks.has(wk);
        const hitMonths=months.size<monthly&&!months.has(mon);
        if(hitDays)days.add(day);
        if(hitWeeks)weeks.add(wk);
        if(hitMonths)months.add(mon);
        if(hitDays||hitWeeks||hitMonths)keep.push(t);
      }
      for(const t of keep)console.log(t);
    });' "$KEEP_DAILY" "$KEEP_WEEKLY" "$KEEP_MONTHLY"
}