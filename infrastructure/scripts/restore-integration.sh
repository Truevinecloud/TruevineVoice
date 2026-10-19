#!/usr/bin/env bash
# Real Docker integration, deliberately restricted to a fresh hosted runner.
# Uses the actual db-verify.sh CLI without replacing functions or Docker calls.
set -euo pipefail

die() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
[ "${GITHUB_ACTIONS:-}" = true ] &&
  [ "${RUNNER_ENVIRONMENT:-}" = github-hosted ] &&
  [ "${RUNNER_OS:-}" = Linux ] || die 'requires a GitHub-hosted Linux runner'
[ -n "${RUNNER_TEMP:-}" ] && [ -d "$RUNNER_TEMP" ] || die 'missing runner temporary directory'
[[ "${GITHUB_RUN_ID:-}" =~ ^[0-9]+$ ]] || die 'missing run id'
[[ "${GITHUB_RUN_ATTEMPT:-}" =~ ^[0-9]+$ ]] || die 'missing run attempt'
case "${1:-}" in ''|--cleanup) ;; *) die 'usage: restore-integration.sh [--cleanup]' ;; esac

# Ignore inherited contexts, remote hosts, TLS credentials and database URLs.
unset DOCKER_CONTEXT DOCKER_TLS_VERIFY DOCKER_CERT_PATH DATABASE_URL PGHOST PGPORT PGUSER PGPASSWORD PGSERVICE PGSERVICEFILE
export DOCKER_HOST=unix:///var/run/docker.sock
[ -S /var/run/docker.sock ] || die 'runner-local Docker socket is missing'
docker info >/dev/null

readonly run="${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}"
readonly label="truevine.restore.integration=${run}"
readonly work="${RUNNER_TEMP}/truevine-restore-integration"
readonly fixture=truevine-postgres
readonly fixture_volume="truevine-restore-source-${run}"
readonly script="$(cd "$(dirname "$0")" && pwd)/db-verify.sh"

cleanup_resources() {
  # A marker is created only after the empty-daemon assertion. No global prune.
  [ -f "$work/owner" ] || return 0
  [ "$(cat "$work/owner")" = "$run" ] || die 'cleanup owner mismatch'
  local id name value failed=0
  for id in $(docker ps -aq --filter "label=$label"); do
    value=$(docker inspect --format '{{index .Config.Labels "truevine.restore.integration"}}' "$id")
    [ "$value" = "$run" ] || die 'fixture ownership changed'
    docker rm -fv "$id" >/dev/null || failed=1
  done
  # The daemon was empty before this harness; these labels belong exclusively
  # to the real recovery subprocesses it launched. Recheck labels before removal.
  for id in $(docker ps -aq --filter label=truevine.verify.run); do
    name=$(docker inspect --format '{{.Name}}' "$id")
    value=$(docker inspect --format '{{index .Config.Labels "truevine.verify.run"}}' "$id")
    [[ "$name" = /truevine-verify-* && -n "$value" ]] || die 'unexpected rehearsal container'
    docker rm -fv "$id" >/dev/null || failed=1
  done
  for name in $(docker volume ls -q --filter label=truevine.verify.run); do
    value=$(docker volume inspect --format '{{index .Labels "truevine.verify.run"}}' "$name")
    [[ "$name" = truevine-verify-* && -n "$value" ]] || die 'unexpected rehearsal volume'
    docker volume rm "$name" >/dev/null || failed=1
  done
  for name in $(docker volume ls -q --filter "label=$label"); do
    value=$(docker volume inspect --format '{{index .Labels "truevine.restore.integration"}}' "$name")
    [ "$value" = "$run" ] || die 'fixture volume ownership changed'
    docker volume rm "$name" >/dev/null || failed=1
  done
  return "$failed"
}

if [ "${1:-}" = --cleanup ]; then
  cleanup_resources
  exit 0
fi

# Refuse reuse of any daemon containing data, even if names look familiar.
initial_containers=$(docker ps -aq) || die 'cannot inspect runner containers'
initial_volumes=$(docker volume ls -q) || die 'cannot inspect runner volumes'
[ -z "$initial_containers" ] || die 'Docker daemon already has containers'
[ -z "$initial_volumes" ] || die 'Docker daemon already has volumes'
[ ! -e "$work" ] || die 'integration state already exists'
mkdir -m 700 "$work"
printf '%s\n' "$run" > "$work/owner"
on_exit() {
  local rc=$?
  trap - EXIT
  cleanup_resources || { printf 'FAIL: emergency cleanup failed\n' >&2; rc=1; }
  exit "$rc"
}
trap on_exit EXIT
trap 'exit 143' TERM
trap 'exit 130' INT

docker pull postgres:18-alpine
docker volume create --label "$label" "$fixture_volume" >/dev/null
# Fixed source name satisfies the recovery script's identity guard, but this is
# a newly created labeled fixture, never an existing/remote production resource.
docker run -d --name "$fixture" --network none --label "$label" \
  --mount "type=volume,src=${fixture_volume},dst=/var/lib/postgresql" \
  -e POSTGRES_HOST_AUTH_METHOD=trust -e POSTGRES_USER=truevine \
  -e POSTGRES_DB=truevine_voice postgres:18-alpine >/dev/null
ready=0
for attempt in $(seq 1 90); do
  if docker logs "$fixture" 2>&1 | grep -Fq 'PostgreSQL init process complete' &&
     docker exec "$fixture" psql -v ON_ERROR_STOP=1 -U truevine -d truevine_voice -tAc 'SELECT 1;' >/dev/null 2>&1; then
    ready=1; break
  fi
  sleep 1
done
[ "$ready" = 1 ] || die 'fixture failed to start'
readonly fixture_id="$(docker inspect --format '{{.Id}}' "$fixture")"

docker exec -i "$fixture" psql -v ON_ERROR_STOP=1 -U truevine -d truevine_voice <<'SQL'
CREATE TYPE public.fixture_state AS ENUM ('ready', 'done');
CREATE TABLE public.organizations (id integer PRIMARY KEY, state public.fixture_state NOT NULL);
CREATE TABLE public.memberships (organization_id integer REFERENCES public.organizations(id), user_id integer, PRIMARY KEY (organization_id, user_id));
CREATE TABLE public._prisma_migrations (migration_name text, finished_at timestamptz, rolled_back_at timestamptz, applied_steps_count integer);
INSERT INTO public.organizations VALUES (1, 'ready');
INSERT INTO public.memberships VALUES (1, 1);
INSERT INTO public._prisma_migrations VALUES ('fixture_only_no_migration_executed', NULL, NULL, 0);
DO $$ BEGIN
  FOR i IN 1..8 LOOP
    EXECUTE format('CREATE TABLE public.fixture_%s (id integer PRIMARY KEY, value text NOT NULL)', i);
    EXECUTE format('INSERT INTO public.fixture_%s VALUES (1, %L)', i, 'representative test data');
  END LOOP;
END $$;
CREATE INDEX fixture_value_idx ON public.fixture_1(value);
CREATE VIEW public.fixture_report AS SELECT * FROM public.organizations;
CREATE SCHEMA private;
CREATE TABLE private.excluded_from_public_count (id integer PRIMARY KEY);
INSERT INTO private.excluded_from_public_count VALUES (1);
SQL

assert_fixture_only() {
  local containers volumes
  containers=$(docker ps -aq --no-trunc) || die 'cannot inspect containers after rehearsal'
  volumes=$(docker volume ls -q) || die 'cannot inspect volumes after rehearsal'
  [ "$containers" = "$fixture_id" ] || die 'rehearsal container leaked or fixture removed'
  [ "$volumes" = "$fixture_volume" ] || die 'rehearsal volume leaked or fixture removed'
  [ "$(docker inspect --format '{{.HostConfig.NetworkMode}}' "$fixture")" = none ] || die 'fixture network changed'
  [ "$(docker inspect --format '{{len .HostConfig.PortBindings}}' "$fixture")" = 0 ] || die 'fixture publishes ports'
}

check_archive() {
  local backup=$1 toc="$work/archive.toc"
  docker exec -i "$fixture" pg_restore --list < "$backup" > "$toc"
  # Independent fixture expectations; the actual corrected parser runs inside
  # db-verify.sh. Include a private table and public view to exercise its scope.
  [ "$(grep -cE '^[0-9]+; [0-9]+ [0-9]+ TABLE public ' "$toc")" = 11 ] || die 'expected 11 public definitions'
  [ "$(grep -cE '^[0-9]+; [0-9]+ [0-9]+ TABLE DATA public ' "$toc")" = 11 ] || die 'expected 11 public data entries'
  [ "$(grep -cE ' TABLE( DATA)? public ' "$toc")" = 22 ] || die 'fixture does not reproduce double counting'
}

run_case() {
  local command=$1 outcome=$2 backup=$3 log="$work/${1}-${2}.log" rc=0
  # Each invocation is its own process, so the actual EXIT cleanup runs on both
  # successful and failed restores. Do not replace Docker or script functions.
  bash "$script" "$command" "$backup" > "$log" 2>&1 || rc=$?
  cat "$log"
  grep -Fq 'archive declares 11 public table(s)' "$log" || die 'incorrect archive table count'
  if [ "$outcome" = success ]; then
    [ "$rc" = 0 ] || die "$command unexpectedly failed ($rc)"
    grep -Fq 'restored database holds at least the 11 table(s)' "$log" || die 'schema verification did not run'
    grep -Fq 'RESULT: PASS' "$log" || die 'missing successful result'
    grep -Fq 'R|organizations|1' "$log" || {
      # verify-volume prints hashes instead of fingerprint rows.
      [ "$command" = verify-volume ] && grep -Fq 'fingerprints identical' "$log"
    } || die 'restored fingerprint missing'
  else
    [ "$rc" = 1 ] || die "expected restore failure exit 1, got $rc"
    grep -Fq 'schema "failure_fixture" does not exist' "$log" || die 'failure did not originate in PostgreSQL restore'
    if grep -Fq 'pg_restore completed with no errors' "$log"; then die 'restore error was hidden'; fi
  fi
  assert_fixture_only
  [ -s "$backup" ] || die 'backup removed'
  printf 'PASS: %s %s; no temporary containers or volumes remain\n' "$command" "$outcome"
}

docker exec "$fixture" pg_dump -U truevine -d truevine_voice -Fc > "$work/success.dump"
check_archive "$work/success.dump"
for command in verify-restore verify-volume; do run_case "$command" success "$work/success.dump"; done

# A valid archive with an intentionally omitted dependency causes a real
# CREATE TABLE error after the target container and volume have been created.
docker exec -i "$fixture" psql -v ON_ERROR_STOP=1 -U truevine -d truevine_voice <<'SQL'
CREATE SCHEMA failure_fixture;
CREATE FUNCTION failure_fixture.default_value() RETURNS text LANGUAGE sql AS $$ SELECT 'test'::text $$;
ALTER TABLE public.fixture_1 ALTER COLUMN value SET DEFAULT failure_fixture.default_value();
SQL
docker exec "$fixture" pg_dump -U truevine -d truevine_voice -Fc --exclude-schema=failure_fixture > "$work/failure.dump"
check_archive "$work/failure.dump"
for command in verify-restore verify-volume; do run_case "$command" failure "$work/failure.dump"; done

cleanup_resources
remaining_containers=$(docker ps -aq) || die 'cannot inspect final containers'
remaining_volumes=$(docker volume ls -q) || die 'cannot inspect final volumes'
[ -z "$remaining_containers" ] || die 'containers remain after final cleanup'
[ -z "$remaining_volumes" ] || die 'volumes remain after final cleanup'
trap - EXIT
printf 'PASS: isolated real Docker integration; fixture and rehearsal resources removed\n'
