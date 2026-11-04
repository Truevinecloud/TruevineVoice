#!/usr/bin/env bash
set -euo pipefail

# Read-only freshness check for the nightly backup. Intended for an external
# monitor or a manually run validation. Does not create or modify backups.
STATUS_FILE="${BACKUP_STATUS_FILE:-/var/lib/truevine-backup/status.json}"
MAX_AGE_HOURS="${BACKUP_MAX_AGE_HOURS:-30}"

if [ ! -s "$STATUS_FILE" ]; then
  echo "BLOCKED: backup status file is missing or empty: $STATUS_FILE" >&2
  exit 2
fi

state=$(sed -n 's/.*"state"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$STATUS_FILE" | head -1)
exit_code=$(sed -n 's/.*"exit_code"[[:space:]]*:[[:space:]]*\([0-9]*\).*/\1/p' "$STATUS_FILE" | head -1)
timestamp=$(sed -n 's/.*"timestamp"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$STATUS_FILE" | head -1)

if [ "$state" != "ok" ] || [ "${exit_code:-1}" != "0" ]; then
  echo "FAIL: backup state=$state exit_code=${exit_code:-unknown}" >&2
  exit 1
fi

if [ -z "$timestamp" ]; then
  echo "FAIL: backup timestamp is missing" >&2
  exit 1
fi

backup_epoch=$(date -d "${timestamp:0:4}-${timestamp:4:2}-${timestamp:6:2}T${timestamp:9:2}:${timestamp:11:2}:${timestamp:13:2}Z" +%s 2>/dev/null || true)
now_epoch=$(date +%s)
if [ -z "$backup_epoch" ] || [ $((now_epoch - backup_epoch)) -gt $((MAX_AGE_HOURS * 3600)) ]; then
  echo "FAIL: backup is older than $MAX_AGE_HOURS hours" >&2
  exit 1
fi

echo "PASS: backup state=ok timestamp=$timestamp"
