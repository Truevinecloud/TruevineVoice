#!/usr/bin/env bash
# monitor-resources.sh — Host resource usage monitoring for Truevine Voice.
#
# Collects CPU load, memory, and filesystem usage using existing operating
# system facilities (df, /proc/stat, /proc/meminfo). Outputs one JSON object
# per line to stdout for log shipping or alerting.
#
# All values are read-only snapshots. Unavailable metrics are reported as
# null, never zero.
#
# No credentials, secrets, or customer information are ever collected or
# emitted. No external network requests are made.
#
# Usage: ./monitor-resources.sh [mount_point]
#   mount_point defaults to /

set -euo pipefail

MOUNT="${1:-/}"
NOW_ISO() { date -u +%Y-%m-%dT%H:%M:%SZ; }

# --- CPU load from /proc/stat ---
read_cpu_load() {
  if [ ! -r /proc/stat ]; then
    echo '{"status":"unknown","error":"/proc/stat not readable"}'
    return
  fi

  # Read first line of /proc/stat: cpu  user nice system idle iowait irq softirq steal guest guest_nice
  local line
  line=$(head -n1 /proc/stat 2>/dev/null || true)
  if [ -z "$line" ]; then
    echo '{"status":"unknown","error":"could not read /proc/stat"}'
    return
  fi

  # Parse: cpu  user nice system idle iowait irq softirq steal ...
  local -a fields
  read -r _ user nice system idle iowait irq softirq steal _ <<< "$line"

  local total=$((user + nice + system + idle + iowait + irq + softirq + steal + 0))
  local idle_total=$((idle + iowait + 0))
  local work=$((total - idle_total))

  local cpu_percent=0
  if [ "$total" -gt 0 ]; then
    cpu_percent=$((work * 1000 / total))
  fi

  # CPU count from /proc/stat
  local cpu_count=0
  while IFS= read -r cpu_line; do
    case "$cpu_line" in
      cpu[0-9]*) cpu_count=$((cpu_count + 1)) ;;
    esac
  done < /proc/stat

  local load_percent="null"
  if [ "$cpu_count" -gt 0 ]; then
    # Convert tenths of a percent to a decimal percentage
    load_percent=$(echo "scale=2; $cpu_percent / 10 / $cpu_count" | bc 2>/dev/null || echo "null")
  fi

  cat <<EOF
{"status":"ok","cpuPercent":${load_percent},"cpuCount":${cpu_count}}
EOF
}

# --- Memory from /proc/meminfo ---
read_memory() {
  if [ ! -r /proc/meminfo ]; then
    echo '{"status":"unknown","error":"/proc/meminfo not readable"}'
    return
  fi

  local mem_total=0
  local mem_free=0
  local mem_available=0

  while IFS=: read -r key value; do
    key=$(echo "$key" | tr -d ' ')
    value=$(echo "$value" | tr -d ' kB')
    case "$key" in
      MemTotal) mem_total=$value ;;
      MemFree) mem_free=$value ;;
      MemAvailable) mem_available=$value ;;
    esac
  done < /proc/meminfo

  local mem_used=$((mem_total - mem_available + 0))
  local used_percent="null"
  if [ "$mem_total" -gt 0 ]; then
    used_percent=$(echo "scale=2; $mem_used * 100 / $mem_total" | bc 2>/dev/null || echo "null")
  fi

  cat <<EOF
{"status":"ok","memoryTotalBytes":$((mem_total * 1024)),"memoryFreeBytes":$((mem_available * 1024)),"memoryUsedBytes":$((mem_used * 1024)),"memoryUsedPercent":${used_percent}}
EOF
}

# --- Disk from df ---
read_disk() {
  local mount="$1"
  if [ ! -r "$mount" ]; then
    echo "{\"status\":\"unknown\",\"error\":\"mount $mount not readable\"}"
    return
  fi

  local output
  output=$(df -k "$mount" 2>/dev/null || true)
  if [ -z "$output" ]; then
    echo "{\"status\":\"unknown\",\"error\":\"df failed for $mount\"}"
    return
  fi

  # Second line of df output contains the data
  local data_line
  data_line=$(echo "$output" | sed -n '2p' | tr -s ' ')
  if [ -z "$data_line" ]; then
    echo "{\"status\":\"unknown\",\"error\":\"could not parse df output for $mount\"}"
    return
  fi

  local -a parts
  read -r _ total_kb used_kb avail_kb _ <<< "$data_line"

  local total_bytes=$((total_kb * 1024 + 0))
  local used_bytes=$((used_kb * 1024 + 0))
  local free_bytes=$((avail_kb * 1024 + 0))
  local free_percent="null"
  if [ "$total_bytes" -gt 0 ]; then
    free_percent=$(echo "scale=2; $free_bytes * 100 / $total_bytes" | bc 2>/dev/null || echo "null")
  fi

  cat <<EOF
{"status":"ok","diskTotalBytes":${total_bytes},"diskFreeBytes":${free_bytes},"diskUsedBytes":${used_bytes},"diskFreePercent":${free_percent}}
EOF
}

# --- Main ---
echo "{\"timestamp\":\"$(NOW_ISO)\",\"mount\":\"$MOUNT\",\"cpu\":$(read_cpu_load),\"memory\":$(read_memory),\"disk\":$(read_disk "$MOUNT")}"
