#!/usr/bin/env bash
#
# Runtime safety tests for infrastructure/scripts/db-verify.sh.
#
# These are RUNTIME tests: the script is executed and its behaviour observed.
# They need no Docker daemon, no PostgreSQL and no VPS. A stub `docker` on PATH
# models containers, volumes, labels, mounts and failures in a temp directory.
#
# Distinct from the static assertions in deploy.spec.ts, which check the
# script's text rather than its behaviour.
#
set -u
SCRIPT="${1:-$(dirname "$0")/db-verify.sh}"
[ "$(uname -s)" = Linux ] || { echo "SKIP: runtime tests are POSIX/Linux only"; exit 0; }
STATE=${TMPDIR:-/tmp}/dbv
BIN=$STATE/bin
LABEL_KEY=truevine.verify.run
export PATH="$BIN:$PATH"
fails=0
ok()  { printf '  OK    %s\n' "$*"; }
bad() { printf '  FAIL  %s\n' "$*"; fails=$((fails + 1)); }
t()   { local d=$1 want=$2; shift 2; local out rc
  out=$("$@" 2>&1); rc=$?
  if [ "$rc" = "$want" ]; then printf '  OK    %s (exit %s)\n' "$d" "$rc"
  else printf '  FAIL  %s (exit %s, want %s)\n%s\n' "$d" "$rc" "$want" "$out"; fails=$((fails+1)); fi; }

write_stub() {
  local ready_sleep=${1:-0}
  # Containers are stored as  name|network|mount-source|label
  # Volumes as               label
  # A label is stored as "key=value" so that a `--filter label=KEY` query can
  # match on the KEY, exactly as Docker does. Storing only the value (an earlier
  # version of this stub) silently made every label filter match nothing, so the
  # tests passed for the wrong reason.
  cat > "$BIN/docker" <<STUB
#!/usr/bin/env bash
S=$STATE
KEY=$LABEL_KEY
mode() { [ -f "\$S/mode" ] && cat "\$S/mode" || echo normal; }
echo "\$*" >> "\$S/calls"
args=("\$@")
getval() { local k=\$1 j=0; while [ \$j -lt \${#args[@]} ]; do
             [ "\${args[\$j]}" = "\$k" ] && { echo "\${args[\$((j+1))]}"; return; }; j=\$((j+1)); done; }
NEWLABEL=""
for j in "\${!args[@]}"; do
  if [ "\${args[\$j]}" = "--label" ] && [ "\${args[\$((j+1))]#truevine.verify.run=}" != "\${args[\$((j+1))]}" ]; then
    NEWLABEL="\${args[\$((j+1))]}"
  fi
done
labelval() { printf '%s' "\$1" | sed -n "s/^\$KEY=//p"; }
haslabel() { printf '%s' "\$1" | grep -q "^\$KEY=" ; }
case "\$1" in
  run)
    name=\$(getval --name); net=\$(getval --network)
    mount=\$(getval --mount); volsrc=""
    case "\$mount" in src=*) volsrc="\${mount#src=}"; volsrc="\${volsrc%%,*}";; esac
    [ "\$(mode)" = failrun ] && { echo "stub: docker run failed" >&2; exit 1; }
    printf '%s|%s|%s|%s\n' "\$name" "\$net" "\$volsrc" "\$NEWLABEL" > "\$S/containers/\$name"
    printf 'id%s' "\$name" | md5sum | cut -c1-32; exit 0 ;;
  volume)
    case "\${2:-}" in
      create) v=""; j=2
             while [ \$j -lt \${#args[@]} ]; do
               case "\${args[\$j]}" in truevine.verify.run=*) v="\${args[\$j]}";; esac
               j=\$((j+1))
             done
             printf '%s\n' "\$v" > "\$S/volumes/\${3:-}"
             echo "\${3:-}"; exit 0 ;;
      ls) flt=\$(getval --filter); key="\${flt#label=}"
          for f in "\$S"/volumes/*; do [ -e "\$f" ] || continue
            n=\$(basename "\$f"); l=\$(cat "\$f")
            if [ -z "\$key" ] || haslabel "\$l"; then printf '%s\n' "\$n"; fi
          done; exit 0 ;;
      inspect) f="\$S/volumes/\${3:-}"; [ -f "\$f" ] || exit 1
             case "\$*" in *Mountpoint*) echo "/var/lib/docker/volumes/\${3}/_data";;
                                *Labels*) labelval "\$(cat "\$f")";; esac; exit 0 ;;
      rm) f="\$S/volumes/\${3:-}"; [ -f "\$f" ] || { echo "no such volume" >&2; exit 1; }
          rm -f "\$f"; exit 0 ;;
    esac ;;
  inspect)
    name="\${2:-}"; fmt="\${4:-}"; f="\$S/containers/\$name"
    if [ -f "\$f" ]; then
      case "\$fmt" in
        *Id*) printf 'id%s' "\$name" | md5sum | cut -c1-32 ;;
        *Labels*) labelval "\$(cut -d'|' -f4 "\$f")" ;;
        *State.Running*) echo true ;;
        *State.StartedAt*) echo 2026-10-13T08:55:37.072760283Z ;;
        *RestartCount*) echo 0 ;;
      esac; exit 0
    fi
    if [ "\$name" = truevine-postgres ] || [ "\$name" = truevine-redis ]; then
      case "\$fmt" in
        *Id*) echo prodid0000000000000000000000000000000000000000000000000000 ;;
        *Labels*) echo "" ;;
        *State.Running*) echo true ;;
        *State.StartedAt*) echo 2026-10-13T08:55:37.072760283Z ;;
        *RestartCount*) echo 0 ;;
      esac; exit 0
    fi
    exit 1 ;;
  ps)
    flt=\$(getval --filter); volf=""
    case "\$flt" in volume=*) volf="\${flt#volume=}";; esac
    fmt=\$(getval --format)
    want_id=0; case " \$* " in *" -aq "*|*" -q "*|*" -qa "*) want_id=1;; esac
    for f in "\$S"/containers/*; do
      [ -e "\$f" ] || continue
      n=\$(basename "\$f"); net=\$(cut -d'|' -f2 "\$f"); src=\$(cut -d'|' -f3 "\$f"); l=\$(cut -d'|' -f4 "\$f")
      case "\$flt" in label=*) haslabel "\$l" || continue;; esac
      if [ -n "\$volf" ] && [ "\$src" != "\$volf" ]; then continue; fi
      # Honour --format: the script asks for names, and for ids with -aq.
      if [ "\$want_id" = 1 ]; then printf 'id%s' "\$n" | md5sum | cut -c1-32; continue; fi
      case "\$fmt" in
        *Names*) printf '%s\n' "\$n" ;;
        *)       printf '%s|%s|%s|%s\n' "\$n" "\$net" "\$src" "\$l" ;;
      esac
    done; exit 0 ;;
  rm) [ "\$(mode)" = failrm ] && { echo "stub: rm failed" >&2; exit 1; }
      shift
      for t in "\$@"; do
        if [ -f "\$S/containers/\$t" ]; then rm -f "\$S/containers/\$t"; continue; fi
        for f in "\$S"/containers/*; do
          [ -e "\$f" ] || continue
          [ "\$(printf 'id%s' "\$(basename "\$f")" | md5sum | cut -c1-32)" = "\$t" ] && rm -f "\$f"
        done
      done
      exit 0 ;;
  exec)
    for a in "\$@"; do
      if [ "\$a" = pg_isready ]; then [ "$ready_sleep" != 0 ] && sleep "\$ready_sleep"; exit 0; fi
      case "\$a" in PING) echo PONG; exit 0;; esac
    done
    case "\$*" in
      *psql*) echo 1; exit 0;;
      *redis-cli\ KEYS*) exit 0;;
      *redis-cli\ GET*) echo x; exit 0;;
      *redis-cli\ EXISTS*) echo 1; exit 0;;
    esac
    exit 0 ;;
  image|logs|cp|version|port) exit 0 ;;
esac
exit 0
STUB
  chmod +x "$BIN/docker"
}

reset() { rm -rf "$STATE"; mkdir -p "$BIN" "$STATE/containers" "$STATE/volumes"; write_stub "${1:-0}"; }
mkfake() { printf 'PGDMP' > "$STATE/fake.dump"; head -c 300 /dev/zero >> "$STATE/fake.dump"; }

echo "script under test: $SCRIPT"

echo
echo "=== 0. the stub models Docker label filters correctly ==="
reset
# Records are  name|network|mount-source|label
printf 'plain|none|-|no-label\n'                  > "$STATE/containers/plain"
printf 'labelled|none|-|truevine.verify.run=abc\n' > "$STATE/containers/labelled"
n=$(docker ps -a --filter "label=truevine.verify.run" --format '{{.Names}}' 2>/dev/null | tr '\n' ' ')
[ "$n" = "labelled " ] && ok "stub label filter matches only labelled resources" \
  || bad "stub label filter returned '$n' (expected only 'labelled')"

echo
echo "=== 1. usage errors fail fast without reaching the daemon ==="
reset
t "no subcommand exits 2"                 2 bash "$SCRIPT"
t "unknown subcommand exits 2"             2 bash "$SCRIPT" nonsense
t "verify-restore without a dump exits 2"  2 bash "$SCRIPT" verify-restore
t "verify-volume without a dump exits 2"   2 bash "$SCRIPT" verify-volume
n=$(grep -c . "$STATE/calls" 2>/dev/null || echo 0)
[ "$n" -eq 0 ] && ok "zero docker calls during usage errors" || bad "$n docker calls during usage errors"

echo
echo "=== 2. bad backup inputs are refused before any restore ==="
reset; mkfake
printf 'junk' > "$STATE/junk.dump"; : > "$STATE/empty.dump"
out=$(bash "$SCRIPT" verify-restore "$STATE/junk.dump" 2>&1 || true)
case "$out" in *"not a PostgreSQL custom-format"*) ok "non-PGDMP rejected";; *) bad "non-PGDMP not rejected";; esac
out=$(bash "$SCRIPT" verify-restore "$STATE/empty.dump" 2>&1 || true)
case "$out" in *"is empty"*) ok "zero-byte backup rejected";; *) bad "empty backup not rejected";; esac
out=$(bash "$SCRIPT" verify-restore "$STATE/absent.dump" 2>&1 || true)
case "$out" in *"not found"*) ok "missing backup rejected";; *) bad "missing backup not rejected";; esac

echo
echo "=== 3. a RENAMED production container with no tool label is never removed ==="
reset
printf 'truevine-verify-pg-a-RENAMED|none|truevine-verify-pg-1|\n' \
  > "$STATE/containers/truevine-verify-pg-a-RENAMED"
printf '\n' > "$STATE/volumes/truevine-verify-pg-1"
bash "$SCRIPT" cleanup --all-runs >/dev/null 2>&1 || true
[ -f "$STATE/containers/truevine-verify-pg-a-RENAMED" ] \
  && ok "renamed, unlabelled container survived --all-runs" \
  || bad "cleanup removed an unlabelled container"
[ -f "$STATE/volumes/truevine-verify-pg-1" ] \
  && ok "renamed, unlabelled volume survived --all-runs" \
  || bad "cleanup removed an unlabelled volume"

echo
echo "=== 4. cleanup is label-scoped, never name-scoped ==="
reset
printf 'unrelated-app|none|-|no-label\n' > "$STATE/containers/unrelated-app"
printf 'no-label\n' > "$STATE/volumes/unrelated-vol"
printf 'truevine-verify-pg-b-old|none|-|truevine.verify.run=old-run-1\n' \
  > "$STATE/containers/truevine-verify-pg-b-old"
printf 'truevine.verify.run=old-run-1\n' > "$STATE/volumes/truevine-verify-pg-old"
bash "$SCRIPT" cleanup >/dev/null 2>&1 || true
[ -f "$STATE/containers/unrelated-app" ]   && ok "unlabelled container survived default cleanup"  || bad "deleted unlabelled container"
[ -f "$STATE/volumes/unrelated-vol" ]      && ok "unlabelled volume survived default cleanup"     || bad "deleted unlabelled volume"
[ -f "$STATE/containers/truevine-verify-pg-b-old" ] \
  && ok "default cleanup left another run's labelled container alone" \
  || bad "default cleanup deleted another run's resource"
bash "$SCRIPT" cleanup --all-runs >/dev/null 2>&1 || true
[ -f "$STATE/containers/truevine-verify-pg-b-old" ] \
  && bad "--all-runs should reap a labelled container from an earlier run" \
  || ok "--all-runs reaped the earlier run's labelled container"
[ -f "$STATE/volumes/truevine-verify-pg-old" ] \
  && bad "--all-runs should reap a labelled volume from an earlier run" \
  || ok "--all-runs reaped the earlier run's labelled volume"
[ -f "$STATE/containers/unrelated-app" ] && ok "unlabelled container still survives --all-runs" || bad "--all-runs deleted an unlabelled container"
[ -f "$STATE/volumes/unrelated-vol" ]    && ok "unlabelled volume still survives --all-runs"    || bad "--all-runs deleted an unlabelled volume"

echo
echo "=== 5. a failed command cleans up only this run's resources ==="
reset
printf 'no-label\n' > "$STATE/volumes/keep-vol"
printf 'keep-ctr|none|-|no-label\n' > "$STATE/containers/keep-ctr"
echo failrun > "$STATE/mode"
bash "$SCRIPT" verify-redis >"$STATE/out5" 2>&1 || true
rm -f "$STATE/mode"
left=$(ls "$STATE/containers" 2>/dev/null | wc -l | tr -d ' ')
[ "$left" = "1" ] && ok "only the pre-existing container remains after failure" \
  || bad "expected 1 container after failure, found $left"
[ -f "$STATE/volumes/keep-vol" ]  && ok "unrelated volume survived a failed run"  || bad "failed run deleted an unrelated volume"
[ -f "$STATE/containers/keep-ctr" ] && ok "unrelated container survived a failed run" || bad "failed run deleted an unrelated container"

echo
echo "=== 6. an interrupt leaves nothing behind ==="
reset 30
mkfake
bash "$SCRIPT" verify-restore "$STATE/fake.dump" >/dev/null 2>&1 &
pid=$!
sleep 4
kill -INT "$pid" 2>/dev/null || true
wait "$pid" 2>/dev/null || true
left=$(ls "$STATE/containers" 2>/dev/null | wc -l | tr -d ' ')
[ "$left" = "0" ] && ok "interrupt left no container behind" || bad "$left container(s) survived an interrupt"
leftv=$(ls "$STATE/volumes" 2>/dev/null | wc -l | tr -d ' ')
[ "$leftv" = "0" ] && ok "interrupt left no volume behind" || bad "$leftv volume(s) survived an interrupt"

echo
echo "=== 7. no destructive command ever targets a production resource ==="
reset
bash "$SCRIPT" preflight >/dev/null 2>&1 || true
bash "$SCRIPT" cleanup --all-runs >/dev/null 2>&1 || true
if grep -E '^(rm|volume rm) +(truevine-postgres|truevine-redis|truevine-postgres-data|truevine-redis-data)( |$)' \
     "$STATE/calls" >/dev/null 2>&1; then
  bad "a destructive command named a production resource"
else ok "no destructive command named a production resource"; fi
if grep -qE '^(stop|restart|kill) ' "$STATE/calls" 2>/dev/null; then
  bad "the script attempted to stop or restart a container"
else ok "the script never issues stop/restart"; fi

echo
if [ "$fails" -eq 0 ]; then echo "RESULT: PASS"; else echo "RESULT: FAIL ($fails assertion(s))"; fi
exit "$fails"