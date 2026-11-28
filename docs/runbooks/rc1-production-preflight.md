# RC1 production preflight runbook

Status: **preparation/evidence only**. This runbook does not merge, deploy,
dispatch a workflow, migrate production, restore production, activate a provider,
change an account, or approve a release. Every result is evidence for a separate
owner decision.

Target: Ubuntu VPS `77.216.129.196`, application root `/var/www/TruevineVoice`.
Inspect from a trusted administrator SSH session. The local backup and
`db-verify.sh` operations need root or Docker-group access; the read-only Prisma
status command uses the deployment account.

## Authority boundary

- `infrastructure/migrations-reviewed.json` is a **review allow-list only**. It
  permits a migration directory in a deployable tree; it does not apply SQL or
  authorize execution.
- PR and `main` CI use disposable databases only and never apply production
  migrations.
- Production migrations run only inside the protected `deploy.yml` workflow,
  after exact SHA and main-push CI, manual `authorize_production=true`,
  protected environment review, explicit migration approval, and verified
  backup/recovery evidence. `deploy.mjs` runs `prisma migrate deploy` before PM2
  activation; migration failure prevents activation.
- **Never restore into live production in this preflight.** The isolated replay
  below uses a new temporary volume and a `--network none` container. Restoring
  over production discards every write after the backup and requires separate
  explicit owner approval and a controlled cutover.
- Code rollback does not reverse SQL. This runbook does not provide a database
  rollback command.
- Never print `.env`, connection strings, credentials, key material, full PM2
  environments, or raw Prisma diagnostics containing connection metadata. Do
  not run these commands with `bash -x`.

## Evidence labels

Record each labelled result in the approval evidence. A command block without a
label is a step inside the labelled section.

| Label | Evidence required |
| --- | --- |
| `RC1-DEPLOYED-SHA` | Exact deployed Git SHA, `current` link target, recorded `REVISION` |
| `RC1-PG-REDIS-HEALTH` | PostgreSQL/Redis health and loopback-only bindings |
| `RC1-ACCOUNT-ORG-COUNTS` | Aggregate user/organization/membership counts only |
| `RC1-WALLET-LEDGER-INTEGRITY` | Append-only ledger checks, duplicate-reference and balance projection |
| `RC1-INSPECT` | Read-only migration ledger, Prisma status, exact pending migration names |
| `RC1-BACKUP` | Local PGDMP backup and encrypted off-site backup |
| `RC1-CHECK` | Checksum verification and archive readability |
| `RC1-RESTORE-FORWARD` | Isolated restore followed by forward SQL replay |
| `RC1-VOLUME` | Temporary volume identity, mount destination, no production volume |
| `RC1-TIMING` | Measured `pg_restore` duration |
| `RC1-CLEANUP` | Labelled-resource cleanup, backup retention, production unchanged |

## Variables and preconditions

Set these in the shell session. `CANDIDATE_SHA` must be the approved full
40-character main SHA; never a branch name. `BASE_SHA` is the verified RC1
baseline recorded in `docs/release/rc1-migration-plan.md`.

```bash
set -euo pipefail

REPO=/var/www/TruevineVoice
BASE_SHA=8fcb5527165de77ad1e2ac585c54a5a53c5217b9
CANDIDATE_SHA=REPLACE_WITH_APPROVED_FULL_40_CHARACTER_MAIN_SHA
WORK=$(mktemp -d -t truevine-rc1-preflight-XXXXXX)
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
RUN_ID="rc1-preflight-${STAMP}-$$"
LABEL_KEY=truevine.rc1.preflight.run

[[ "$CANDIDATE_SHA" =~ ^[0-9a-f]{40}$ ]]
git -C "$REPO" cat-file -e "${CANDIDATE_SHA}^{commit}"
git -C "$REPO" cat-file -e "${BASE_SHA}^{commit}"
cd "$REPO/current"
test -f infrastructure/scripts/db-verify.sh
test -f infrastructure/backup/restore.sh
```

Stop if the candidate object is absent, the deployed release is unclear, the
production containers are not both running, or Docker images
`postgres:18-alpine` and `redis:8-alpine` are missing. Do not fetch or substitute
another SHA to make a check pass.

## `RC1-DEPLOYED-SHA` — deployed identity

```bash
cd "$REPO"
printf 'deployed_git_head=%s\n' "$(git rev-parse HEAD)"
printf 'current_link=%s\n' "$(readlink -f current)"
printf 'current_revision=%s\n' "$(cat current/REVISION 2>/dev/null || printf 'unrecorded\n')"
printf 'git_status:\n'
git status --short
```

Record the exact values. Do not treat a release build timestamp, branch name,
or reported URL version as a substitute for the Git SHA.

## `RC1-PG-REDIS-HEALTH` — datastore health

```bash
docker inspect --format \
  '{{.Name}} running={{.State.Running}} restarts={{.RestartCount}} started={{.State.StartedAt}}' \
  truevine-postgres truevine-redis

docker exec truevine-postgres psql -v ON_ERROR_STOP=1 -U truevine -d truevine_voice -P pager=off \
  -tAc "SELECT 'pg|version=' || current_setting('server_version') || '|database=' || current_database() || '|role=' || current_user;"

docker exec truevine-redis redis-cli PING
docker exec truevine-redis redis-cli DBSIZE
sudo ss -ltn | grep -E '127\.0\.0\.1:(55432|56379)'
curl -fsS --max-time 20 http://127.0.0.1:3001/health
```

Require `PONG`, the expected loopback bindings, running containers with the
recorded `StartedAt` and `RestartCount`, and `/health` reporting `status: ok`,
both dependencies `up`, `environment: production`, and the deployed SHA.

## `RC1-ACCOUNT-ORG-COUNTS` — aggregate counts only

```bash
docker exec truevine-postgres psql -v ON_ERROR_STOP=1 -U truevine -d truevine_voice -P pager=off \
  -c "SELECT 'users' AS entity, count(*) FROM users
      UNION ALL SELECT 'organizations', count(*) FROM organizations
      UNION ALL SELECT 'memberships', count(*) FROM memberships
      UNION ALL SELECT 'platform_role_assignments', count(*) FROM platform_role_assignments
      UNION ALL SELECT 'wallet_entries', count(*) FROM wallet_entries
      UNION ALL SELECT 'payment_intents', count(*) FROM payment_intents
      UNION ALL SELECT 'top_up_requests', count(*) FROM top_up_requests
      UNION ALL SELECT '_prisma_migrations', count(*) FROM _prisma_migrations
      ORDER BY 1;"
```

Record counts only. Do not query password hashes, tokens, email addresses,
connection strings, or raw ledger descriptions for this evidence.

## `RC1-WALLET-LEDGER-INTEGRITY` — append-only projection

```bash
docker exec truevine-postgres psql -v ON_ERROR_STOP=1 -U truevine -d truevine_voice -P pager=off \
  -c "SELECT count(*) AS zero_amount_entries FROM wallet_entries WHERE amount_minor = 0;"

docker exec truevine-postgres psql -v ON_ERROR_STOP=1 -U truevine -d truevine_voice -P pager=off \
  -c "SELECT count(*) AS duplicate_references FROM (
        SELECT organization_id, reference FROM wallet_entries GROUP BY 1, 2 HAVING count(*) > 1
      ) AS duplicates;"

docker exec truevine-postgres psql -v ON_ERROR_STOP=1 -U truevine -d truevine_voice -P pager=off \
  -c "SELECT count(*) AS mutable_balance_columns FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'wallet_entries' AND column_name ILIKE '%balance%';"

docker exec truevine-postgres psql -v ON_ERROR_STOP=1 -U truevine -d truevine_voice -P pager=off \
  -c "SELECT c.relname, t.tgname, pg_get_triggerdef(t.oid) AS trigger_definition
      FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
      WHERE NOT t.tgisinternal AND c.relname = 'wallet_entries';"

docker exec truevine-postgres psql -v ON_ERROR_STOP=1 -U truevine -d truevine_voice -P pager=off \
  -c "SELECT organization_id, currency, sum(amount_minor) AS balance_minor
      FROM wallet_entries GROUP BY 1, 2 ORDER BY 1, 2;"

docker exec truevine-postgres psql -v ON_ERROR_STOP=1 -U truevine -d truevine_voice -P pager=off \
  -c "SELECT 'audio_asset_operations' AS table_name, count(*) AS duplicate_keys FROM (
        SELECT organization_id, idempotency_key FROM audio_asset_operations GROUP BY 1, 2 HAVING count(*) > 1
      ) AS d
      UNION ALL
      SELECT 'top_up_requests', count(*) FROM (
        SELECT organization_id, idempotency_key FROM top_up_requests GROUP BY 1, 2 HAVING count(*) > 1
      ) AS d
      UNION ALL
      SELECT 'payment_intents', count(*) FROM (
        SELECT organization_id, idempotency_key FROM payment_intents GROUP BY 1, 2 HAVING count(*) > 1
      ) AS d;"
```

Require zero zero-amount rows, zero duplicate references, zero mutable balance
columns, an append-only trigger on `wallet_entries`, zero duplicate durable keys,
and a balance projection that recomputes from entries only. Do not edit ledger
rows to make a finding disappear.

## `RC1-INSPECT` — migration history and exact pending names

The deployed release contains only its own migration files. Its
`prisma migrate status` cannot identify migrations introduced by the newer RC1
schema. Derive the expected pending set from the candidate manifest minus the
live ledger, as shown below.

Read-only Prisma status from the deployed release:

```bash
cd "$REPO/current"
set +e
env -u DATABASE_URL npm run prisma:migrate:status > "$WORK/migrate-status.txt" 2>&1
PRISMA_STATUS_RC=$?
set -e
printf 'prisma_migrate_status_exit=%s\n' "$PRISMA_STATUS_RC"
```

Do not print `migrate-status.txt`; inspect it privately because it can contain
connection metadata. Record only the exit code and migration names/status. A
nonzero exit can mean pending or failed migrations, divergent history, or a
connection failure. Do not substitute `migrate deploy`, `migrate resolve`,
`db push`, or direct SQL.

Ledger detail:

```bash
docker exec truevine-postgres psql -v ON_ERROR_STOP=1 -U truevine -d truevine_voice -P pager=off \
  -c "SELECT migration_name,
        COALESCE(finished_at::text, 'null') AS finished_at,
        COALESCE(rolled_back_at::text, 'null') AS rolled_back_at,
        applied_steps_count, checksum
      FROM _prisma_migrations ORDER BY migration_name;"

docker exec truevine-postgres psql -v ON_ERROR_STOP=1 -U truevine -d truevine_voice -P pager=off \
  -c "SELECT count(*) AS unfinished_migrations FROM _prisma_migrations WHERE finished_at IS NULL;"

docker exec truevine-postgres psql -v ON_ERROR_STOP=1 -U truevine -d truevine_voice -P pager=off \
  -tAc "SELECT migration_name FROM _prisma_migrations
        WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY 1" > "$WORK/applied.txt"
```

Require zero unfinished or rolled-back rows. Now derive the exact lists:

```bash
manifest_names() {
  git -C "$REPO" show "$1:infrastructure/migrations-reviewed.json" |
    node -e 'let s = ""; process.stdin.on("data", d => s += d).on("end", () => {
      for (const name of JSON.parse(s).migrations) console.log(name);
    });'
}

comm -13 \
  <(manifest_names "$BASE_SHA" | sort) \
  <(manifest_names "$CANDIDATE_SHA" | sort) |
  tee "$WORK/candidate-additions.txt"

cat > "$WORK/expected-rc1.txt" <<'EOF'
20261119134000_rbac_015_custom_roles
20261120120000_audio_storage_bytea_w3_04
20261120130000_voice_provider_configuration
20261122120000_voice_callback_receipts
20261122121200_campaign_call_initiation_operation
20261122150000_durable_call_initiation_reconciliation
20261123110000_audio_usage_campaign_set_null
20261123120000_usage_settlement_w5_01
20261124130000_w601_campaign_reliability
20261125120000_w504_sms_fallback_operations
20261126000000_w504_sms_fallback_entitlement
EOF

diff -u "$WORK/expected-rc1.txt" "$WORK/candidate-additions.txt"

comm -23 \
  <(manifest_names "$CANDIDATE_SHA" | sort) \
  <(sort -u "$WORK/applied.txt") |
  tee "$WORK/pending.txt"

diff -u "$WORK/candidate-additions.txt" "$WORK/pending.txt"
test "$(wc -l < "$WORK/pending.txt")" -eq 11
printf 'exact_pending_migration_count=%s\n' "$(wc -l < "$WORK/pending.txt")"
cat "$WORK/pending.txt"

diff -u \
  <(manifest_names "$BASE_SHA" | sort) \
  <(sort -u "$WORK/applied.txt")
```

All three `diff` commands must be empty and the count must be `11`. The last
`diff` proves the live ledger contains exactly the deployed baseline migrations;
it catches any extra applied migration that a candidate-minus-ledger comparison
alone would miss. Any extra, missing, unfinished, or rolled-back migration stops
the preflight. Do not edit the manifest, migration SQL, `_prisma_migrations`, or
live data to make the comparison pass.

## `RC1-BACKUP` — local and encrypted backups

Local custom-format backup (reads production only):

```bash
cd "$REPO/current"
bash infrastructure/scripts/db-verify.sh preflight
bash infrastructure/scripts/db-verify.sh backup

LOCAL_DUMP=$(ls -1t /var/backups/truevinevoice/truevine_voice_*.dump | sed -n '1p')
printf 'local_dump=%s\n' "$LOCAL_DUMP"
```

Encrypted off-site backup. Verify the backup activation prerequisites first; if
the key, environment file, bucket, or status file is absent, stop. Do not create
an ad-hoc key, bucket, or credential to make this step pass.

```bash
cd "$REPO/current"
set +x
set -a
. /etc/truevine/backup.env
set +a

bash infrastructure/backup/backup.sh
STATUS_FILE="${BACKUP_STATUS_FILE:-/var/lib/truevine-backup/status.json}"
test -f "$STATUS_FILE"
node -e 'const s = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  if (s.state !== "ok" || s.exit_code !== 0) process.exit(1);
  console.log("encrypted_backup_status=ok timestamp=" + s.timestamp);' "$STATUS_FILE"

BACKUP_TS=$(bash infrastructure/backup/restore.sh --list | sed -n '1s/^[[:space:]]*//p')
test -n "$BACKUP_TS"
printf 'encrypted_backup_timestamp=%s\n' "$BACKUP_TS"
```

## `RC1-CHECK` — checksum and archive readability

Local dump checksum and readability:

```bash
test -s "$LOCAL_DUMP"
test "$(head -c 5 "$LOCAL_DUMP")" = PGDMP
(cd "$(dirname "$LOCAL_DUMP")" && sha256sum -c "$(basename "$LOCAL_DUMP").sha256")
docker exec -i truevine-postgres pg_restore --list < "$LOCAL_DUMP" | sed -n '1,20p'
```

Require `OK` from `sha256sum -c`, a non-empty table of contents, and no errors.

Encrypted backup verify-only (downloads, checks ciphertext and plaintext
checksums, decrypts, inspects the archive, and leaves no database or plaintext
behind):

```bash
cd "$REPO/current"
set +x
set -a
. /etc/truevine/backup.env
set +a

bash infrastructure/backup/restore.sh --backup "$BACKUP_TS"
```

Require the script's `VERIFY OK` line and its explicit statement that no database
was touched. A local `pg_restore` version mismatch is not archive corruption;
the authoritative readability proof is the isolated replay below, which uses
the matching PostgreSQL image.

## `RC1-RESTORE-FORWARD` — isolated restore-forward rehearsal

This rehearsal restores the local PGDMP backup into a new network-isolated
container on a new labelled volume, then applies the exact pending migration SQL
from `CANDIDATE_SHA` with `psql`. It proves restore plus forward SQL apply. The
replay does not update `_prisma_migrations` and is not an application E2E test.
It never mounts a production volume and never restores over production.

Create rehearsal resources:

```bash
RESTORE_CONTAINER="truevine-rc1-restore-forward-${STAMP}-$$"
RESTORE_VOLUME="${RESTORE_CONTAINER}-vol"

case "$RESTORE_VOLUME" in
  truevine-postgres-data|truevine-redis-data) printf 'refusing production volume\n' >&2; exit 1 ;;
esac

docker image inspect postgres:18-alpine >/dev/null

docker volume create --label "${LABEL_KEY}=${RUN_ID}" "$RESTORE_VOLUME"

docker run -d --name "$RESTORE_CONTAINER" --network none \
  --label "${LABEL_KEY}=${RUN_ID}" \
  --mount "type=volume,src=${RESTORE_VOLUME},dst=/var/lib/postgresql" \
  -e POSTGRES_HOST_AUTH_METHOD=trust \
  -e POSTGRES_DB=truevine_voice \
  postgres:18-alpine >/dev/null

for i in $(seq 1 90); do
  docker exec "$RESTORE_CONTAINER" psql -h 127.0.0.1 -U postgres -d truevine_voice -tAc 'SELECT 1;' >/dev/null 2>&1 && break
  sleep 1
done
docker exec "$RESTORE_CONTAINER" psql -h 127.0.0.1 -U postgres -d truevine_voice -tAc 'SELECT 1;' >/dev/null
```

## `RC1-VOLUME` — temporary volume and mount proof

```bash
docker volume inspect --format \
  '{{.Name}} mountpoint={{.Mountpoint}} labels={{json .Labels}}' "$RESTORE_VOLUME"

docker inspect --format \
  '{{range .Mounts}}{{.Type}} {{.Name}} -> {{.Destination}}{{"\n"}}{{end}}' "$RESTORE_CONTAINER"

test "$(docker inspect --format '{{.HostConfig.NetworkMode}}' "$RESTORE_CONTAINER")" = none
test "$(docker inspect --format '{{json .HostConfig.PortBindings}}' "$RESTORE_CONTAINER")" = '{}'
```

Require the temporary volume name/label, mount destination
`/var/lib/postgresql`, network `none`, and no published ports. The production
volumes `truevine-postgres-data` and `truevine-redis-data` must not appear.

## `RC1-TIMING` — measured restore, then forward SQL replay

```bash
docker cp "$LOCAL_DUMP" "$RESTORE_CONTAINER:/tmp/rc1-preflight.dump"

SECONDS=0
docker exec "$RESTORE_CONTAINER" pg_restore --no-owner --no-privileges \
  -U postgres -d truevine_voice /tmp/rc1-preflight.dump
printf 'restore_seconds=%s\n' "$SECONDS"

docker exec "$RESTORE_CONTAINER" psql -v ON_ERROR_STOP=1 -U postgres -d truevine_voice -P pager=off \
  -tAc "SELECT 'restored_tables=' || count(*) FROM information_schema.tables
        WHERE table_schema = 'public' AND table_type = 'BASE TABLE';"

while IFS= read -r migration; do
  [ -n "$migration" ] || continue
  git -C "$REPO" show "${CANDIDATE_SHA}:packages/database/prisma/migrations/${migration}/migration.sql" \
    > "$WORK/${migration}.sql"
  docker cp "$WORK/${migration}.sql" "$RESTORE_CONTAINER:/tmp/${migration}.sql"
  docker exec "$RESTORE_CONTAINER" psql -v ON_ERROR_STOP=1 -U postgres -d truevine_voice \
    -f "/tmp/${migration}.sql" >/dev/null
  printf 'rehearsed_forward_sql=%s\n' "$migration"
done < "$WORK/pending.txt"
```

Every `restore_seconds` and `rehearsed_forward_sql` line is evidence. Any
`psql` or `pg_restore` error stops the rehearsal.

Forward replay verification:

```bash
test "$(docker exec "$RESTORE_CONTAINER" psql -v ON_ERROR_STOP=1 -U postgres -d truevine_voice -tAc \
  "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'
   AND table_name IN ('voice_usage_quotes','voice_usage_events','voice_usage_reversals');")" = 3

test "$(docker exec "$RESTORE_CONTAINER" psql -v ON_ERROR_STOP=1 -U postgres -d truevine_voice -tAc \
  "SELECT count(*) FROM pg_constraint WHERE conname='voice_callback_bindings_full_key';")" = 1

test "$(docker exec "$RESTORE_CONTAINER" psql -v ON_ERROR_STOP=1 -U postgres -d truevine_voice -tAc \
  "SELECT count(*) FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
   WHERE NOT t.tgisinternal AND c.relname IN
   ('voice_usage_quotes','voice_usage_events','voice_usage_reversals');")" = 6
```

Record the three expected counts. Do not query or record customer data from the
restored database. Do not use this container as an application target: its
`_prisma_migrations` table is intentionally not updated by the raw SQL replay.

## `RC1-CLEANUP` — labelled cleanup and unchanged production

Remove only the resources created by the replay above:

```bash
test "$(docker inspect --format '{{index .Config.Labels "truevine.rc1.preflight.run"}}' "$RESTORE_CONTAINER")" = "$RUN_ID"
test "$(docker volume inspect --format '{{index .Labels "truevine.rc1.preflight.run"}}' "$RESTORE_VOLUME")" = "$RUN_ID"

docker rm -fv "$RESTORE_CONTAINER"
docker volume rm "$RESTORE_VOLUME"
rm -rf "$WORK"

test -z "$(docker ps -a --filter "label=${LABEL_KEY}=${RUN_ID}" --format '{{.Names}}' | tr -d ' ')"
test -z "$(docker volume ls -q --filter "label=${LABEL_KEY}=${RUN_ID}" | tr -d ' ')"
```

The inspect outputs must equal `$RUN_ID` before removal. Do not remove a resource
whose label cannot be proven.

`db-verify.sh` commands already clean their own labelled resources. Run the
explicit cleanup sweep only when no other verification run is in progress; it
still removes only resources carrying the tool's own label:

```bash
cd "$REPO/current"
bash infrastructure/scripts/db-verify.sh cleanup --all-runs

docker ps -a --filter 'label=truevine.verify.run' --format '{{.Names}}' || true
docker volume ls -q --filter 'label=truevine.verify.run' || true
ls -d /tmp/truevine-verify-* 2>/dev/null || printf 'no temp files\n'
```

Backups are never removed by cleanup. Confirm the backup files still exist:

```bash
find /var/backups/truevinevoice -maxdepth 1 -type f \
  \( -name 'truevine_voice_*.dump' -o -name 'truevine_voice_*.dump.sha256' \) \
  -printf '%f\n' | sort
```

Final production-unchanged check; compare `StartedAt` and `RestartCount` with
`RC1-PG-REDIS-HEALTH`:

```bash
docker inspect --format \
  '{{.Name}} running={{.State.Running}} restarts={{.RestartCount}} started={{.State.StartedAt}}' \
  truevine-postgres truevine-redis
curl -fsS --max-time 20 http://127.0.0.1:3001/health
```

## Stop conditions

Stop and report the labelled evidence; do not work around any of these:

- deployed SHA, release directory, or `REVISION` is ambiguous;
- PostgreSQL, Redis, `/health`, or loopback binding check fails;
- any unfinished or rolled-back Prisma migration row exists;
- derived candidate additions, manifest-minus-ledger pending names, the fixed
  11-name list, the deployed-baseline ledger comparison, or the count `11`
  disagree;
- local backup is empty, not `PGDMP`, checksum fails, or `pg_restore --list`
  yields no objects;
- encrypted backup status is not `ok`/`0`, checksum verification fails, or
  `restore.sh` does not report `VERIFY OK`;
- rehearsal container does not prove network `none`, no published ports, a
  dedicated labelled volume, and no production volume mount;
- restore or forward SQL replay emits any error;
- cleanup label is missing or differs from `$RUN_ID`;
- production container `StartedAt` or `RestartCount` changed, or `/health`
  regressed.

## Prohibitions

- No manual `prisma migrate deploy`, `migrate resolve`, `db push`, reset, direct
  SQL update, or hand-edit of applied migration SQL or `_prisma_migrations`.
- No restore into live production and no mount of `truevine-postgres-data` or
  `truevine-redis-data` in a rehearsal container.
- No deletion of backups and no cleanup by container/volume name alone.
- No provider callback, live Voice/SMS action, charge, credit, refund, account
  creation, password change, or role change.
- No treating this runbook, a manifest entry, a disposable rehearsal, or a
  successful code deployment as approval to execute a production migration.
