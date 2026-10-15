# PostgreSQL and Redis recovery runbook

Target: Ubuntu VPS `169.58.162.143`, application root `/var/www/TruevineVoice`.
Companion to [`production-deployment.md`](./production-deployment.md), which
covers releasing application code. This runbook covers the two datastores.

ADR 0003 requires that "backups, point-in-time recovery, and tested restore
procedures are prerequisites for production". The procedures below satisfy the
*tested restore* half of that. Point-in-time recovery and automated backups do
not exist yet — see [Outstanding risks](#outstanding-risks).

## Provenance of these procedures

Every procedure here was performed against the live VPS on **2026-10-15** and
the results are recorded below. The script in
[`infrastructure/scripts/db-verify.sh`](../../infrastructure/scripts/db-verify.sh)
was written **after** those runs, as a refactor of them, and then hardened
following a safety review.

**The script has not been executed against the live VPS.** It has been validated
by shell syntax checking, by runtime tests against a stubbed `docker`
(`db-verify.runtime.sh`), and by static assertions in `deploy.spec.ts`. Treat the
first `db-verify.sh` run as the first real run: watch its output rather than
trusting it blindly.

## Architecture

Both datastores are Docker containers defined by the repository's
`docker-compose.yml`, and the compose project on the server is `truevine-voice`.
That file's header describes itself as *local development infrastructure*; see
[Outstanding risks](#outstanding-risks) before reading it as production
configuration.

| | PostgreSQL | Redis |
| --- | --- | --- |
| Container | `truevine-postgres` | `truevine-redis` |
| Image | `postgres:18-alpine` (18.6) | `redis:8-alpine` (8.10.2) |
| Restart policy | `unless-stopped` | `unless-stopped` |
| Host publish | `127.0.0.1:55432` → `5432` | `127.0.0.1:56379` → `6379` |
| Docker network | `truevine-voice_default` only | `truevine-voice_default` only |
| Volume | `truevine-postgres-data` | `truevine-redis-data` |
| Mount destination | `/var/lib/postgresql` | `/data` |
| Data path | `/var/lib/postgresql/18/docker` | `/data` |
| Persistence | PostgreSQL's own files | `appendonly.aof` (AOF, `everysec`) + `dump.rdb` (`save 60 1`) |

### Why the host ports are not the conventional ones

`POSTGRES_PORT` and `REDIS_PORT` in `.env` select `55432` and `56379` rather than
`5432`/`6379`. The application reads `DATABASE_URL` and `REDIS_URL`, which must
name the same ports. Changing one without the other silently points the
application at something else.

### Network isolation

Neither datastore is publicly reachable. This is asserted at four independent
layers, and a change to any one of them is a regression:

1. **Host socket binding** — `ss -ltnp` shows `127.0.0.1:55432` and
   `127.0.0.1:56379`. The only non-loopback listeners are `22`, `80`, `443`.
2. **Docker DNAT** — the published-port rules are restricted with
   `-d 127.0.0.1/32`. A `0.0.0.0` publish would bypass `ufw` here.
3. **External probe** — from another machine, neither port answers, while 80/443
   do. Always include the control; a probe that fails for everything proves
   nothing.
4. **Network membership** — the two containers share a bridge with no other
   container.

`ufw` is active with a default-deny policy and contains **no rules** for these
ports. That is correct: the control is the loopback binding, not the firewall.

### What actually holds data

`organizations`, `memberships` and `_prisma_migrations` currently contain
0, 0 and 1 rows. All row-level fidelity evidence in this runbook is therefore
schema-and-migration evidence. Redis holds `DBSIZE=0`.

## Standing warnings

> **Never mount `truevine-postgres-data`, `truevine-redis-data`,
> `truevine-postgres` or `truevine-redis` in a temporary or verification
> container.** Even read-only, mounting a live volume into a second PostgreSQL
> instance corrupts it: recovery, locks and WAL replay assume exclusive
> ownership of the data directory.

> **Never copy a live PostgreSQL data directory.** `cp -r` of `$PGDATA` produces
> an unusable cluster — it is not a consistent snapshot, and WAL segments may be
> mid-write. Use `pg_dump` (or `pg_basebackup` for physical copies).

> **These procedures never restart production.** If a step suggests otherwise, it
> is a different procedure and needs its own approval.

## Prerequisites

- Root or a `docker`-group SSH session. The deployment account cannot run
  `docker`.
- Both production containers `running`, with `RestartCount=0`. Record their
  `StartedAt` **before** starting; you will compare it afterwards.
- Free disk (the datastores are small, ~63 M and ~16 K) and free memory.
- `postgres:18-alpine` and `redis:8-alpine` present locally.

```bash
cd /var/www/TruevineVoice
docker inspect --format '{{.Name}} running={{.State.Running}} restarts={{.RestartCount}} started={{.State.StartedAt}}' \
  truevine-postgres truevine-redis
df -h /var/lib/docker
free -m
```

## Procedure 1 — Create and check a PostgreSQL backup

`pg_dump` only reads. It is the only command in these procedures that touches the
production database, and it cannot modify it. `pg_dump` is not installed on the
host; it runs inside the container.

```bash
infrastructure/scripts/db-verify.sh preflight
infrastructure/scripts/db-verify.sh backup
```

Manual equivalent:

```bash
umask 077
TS=$(date -u +%Y%m%dT%H%M%SZ)
OUT=/var/backups/truevinevoice/truevine_voice_${TS}.dump
docker exec truevine-postgres pg_dump -U truevine -d truevine_voice -Fc > "$OUT"
[ -s "$OUT" ] || { rm -f "$OUT"; echo "empty dump, removed"; }
head -c 5 "$OUT"; echo          # must print PGDMP
sha256sum "$OUT" | tee "$OUT.sha256"
```

**Expected output**

```
file   : /var/backups/truevinevoice/truevine_voice_<TS>.dump
size   : 6126 bytes
format : PGDMP (PGDMP)
sha256 : <64 hex characters>
```

**Integrity check.** `sha256sum -c` must report `OK`. Confirm the archive is
readable:

```bash
docker exec -i truevine-postgres pg_restore --list < "$OUT" | head -20
```

**Troubleshooting**

| Symptom | Meaning | Action |
| --- | --- | --- |
| `size 0` | `pg_dump` produced nothing | Delete it. A zero-byte file that looks like a backup is worse than no file. |
| `magic` is not `PGDMP` | not a custom-format archive | Re-run with `-Fc`. |
| `pg_restore: command not found` | run from the host | `pg_restore` is not installed on the host. Pipe the archive into the container: `docker exec -i truevine-postgres pg_restore -l < "$OUT"`. |
| `pg_restore --list` returns 0 entries | **not** corruption | Check whether `pg_restore` exists at all before concluding anything. |

That last row is a real trap: a missing binary behind `2>/dev/null` returns an
empty result that looks exactly like a corrupt archive.

## Procedure 2 — Restore into an isolated temporary instance

Proves the backup is restorable without touching production.

```bash
infrastructure/scripts/db-verify.sh verify-restore /var/backups/truevinevoice/<file>.dump
```

The script creates a uniquely named volume and container, uses
`--network none` with no published ports, mounts the temporary volume at the same
destination production uses (`/var/lib/postgresql`), restores, fingerprints the
result, then removes both.

**Expected output**

```
OK    backup is a non-empty PGDMP archive
OK    volume 'truevine-w109-restore-<TS>' is not a production resource
OK    truevine-w109-restore-<TS> ready after Ns
OK    pg_restore completed with no errors
OK    restored: 53 fingerprint lines captured
RESULT: PASS
```

A restored database should match production on: 3 tables, 18 columns, 6 indexes,
the composite `memberships` primary key `(organization_id, user_id)`, the
`MembershipRole` enum, migration `20261014042915_tenancy_core`, and
`organizations=0 memberships=0 _prisma_migrations=1`.

## Procedure 3 — Prove the volume survives container recreation

This is the stronger claim. It restores into a temporary volume, then destroys
the container while keeping the volume, then starts a **new** container against
that same volume and compares.

```bash
infrastructure/scripts/db-verify.sh verify-volume /var/backups/truevinevoice/<file>.dump
```

**Expected output — the two lines that matter**

```
OK    container id changed (A=63758bf4d56c B=96397f245eb6)
    PostgreSQL Database directory appears to contain a database; Skipping initialization
OK    fingerprints identical
RESULT: PASS
```

- A **different container ID** proves a genuinely new container.
- **"Skipping initialization"** proves PostgreSQL opened the existing cluster
  rather than running `initdb` over the volume.
- **Identical fingerprints** — the script compares a deterministic dump of
  tables, columns, indexes, constraints, enum types, migration records, row
  counts, server major version and `data_directory`.

If the fingerprints differ, the diff is printed. A difference in the `S|` lines
means the cluster was re-initialised and the volume was **not** reused.

## Procedure 4 — Verify Redis persistence

Proves AOF/RDB persistence survives container recreation.

```bash
infrastructure/scripts/db-verify.sh verify-redis
```

Writes a uniquely named synthetic key, forces a `BGSAVE`, removes the container
keeping the volume, recreates the container, and checks the key survived
byte-for-byte.

**Expected output**

```
OK    key readable before recreation
OK    container id changed (A=... B=...)
    Reading RDB base file on AOF loading...
    DB loaded from incr file appendonly.aof.1.incr.aof: 0.001 seconds
OK    key survived container recreation
OK    value is byte-for-byte identical
OK    no test key in production Redis
RESULT: PASS
```

The final assertion matters as much as the key check: it proves the synthetic key
never reached production Redis.

**Troubleshooting**

| Symptom | Meaning | Action |
| --- | --- | --- |
| Key missing after recreation | persistence not working | Check `CONFIG GET appendonly` is `yes` and `dir` is `/data`. Confirm the volume, not the container, holds `/data`. |
| Value differs | truncated write | `appendfsync everysec` can lose the last second on an abrupt kill. Re-run; if it recurs, examine `aof_last_write_status`. |
| Container never ready | port or data conflict | Confirm no previous test container still holds the name. |

## Cleanup verification

Always verify cleanup **in a separate command**, never from the test's own
claims. A run has reported a successful removal while the artifacts were still
present.

```bash
infrastructure/scripts/db-verify.sh cleanup          # this run only
infrastructure/scripts/db-verify.sh cleanup --all-runs   # also reaps earlier runs

# independent confirmation:
docker ps -a --filter "label=truevine.verify.run" --format '{{.Names}}' || true
docker volume ls -q --filter "label=truevine.verify.run" || true
ls -d /tmp/truevine-verify-* 2>/dev/null || echo "no temp files"
docker inspect --format '{{.Name}} running={{.State.Running}} restarts={{.RestartCount}} started={{.State.StartedAt}}' \
  truevine-postgres truevine-redis
curl -s --max-time 20 http://127.0.0.1:3001/health
```

The label filters are the right query: a name filter would also match an
unrelated container that happens to be named similarly.

Production is unaffected when `StartedAt` is unchanged, `RestartCount` is `0`,
and `/health` reports the expected `version` with `postgres` and `redis` `up`.

## How the script protects production

Protection is based on **identity, never on name alone**. A name can be
renamed, copied or guessed; a label cannot be forged by accident.

1. **Every resource the script creates is labelled** `truevine.verify.run=<run
   id>`. Nothing is destroyed unless it carries this run's label. A renamed
   production container has no such label, so it is never a candidate however it
   is called.
2. **Ownership is asserted immediately before every destructive command** and
   fails closed. If identity cannot be established, nothing is removed.
3. **Production identity is captured at start-up** — container ids and volume
   mountpoints — and refused as an independent second guard. A newly created
   container is checked against those ids.
4. **Cleanup, including after a failure or an interrupt, removes only what this
   run created.** `trap` handlers run on `EXIT`, `INT`, `TERM` and `HUP`.
   Backups are never removed by any code path.
5. **The script never issues `stop`, `restart` or `kill`.**

`cleanup` is label-scoped, never name-scoped. It filters on
`label=truevine.verify.run`, so an unrelated container that merely resembles a
test resource is untouched. `--all-runs` reaps resources left by *earlier*
verification runs; it still requires the tool's own label, so it cannot remove
anything the tool did not create.

## Why this script fails loudly

Hand-run verification of these procedures produced a **false pass**: shell
quoting corrupted every SQL query, both sides of the comparison returned the same
error text, and `diff` reported them as identical. The script exists to make
that impossible.

- `set -euo pipefail`, so a failing command does not continue quietly.
- SQL is fed from a file, never interpolated into shell quotes.
- `psql -v ON_ERROR_STOP=1`, and **any** `ERROR` in output aborts the run rather
  than being compared as a result.
- Every `docker` invocation's exit status is asserted.
- Restore preconditions are validated **before** anything is restored: the
  production role must be readable, the archive must yield a table of contents,
  and it must declare at least one table. A missing `pg_restore` is detected
  rather than being read as an empty (and therefore "valid") listing.
- After a restore, the restored table count is checked against the number of
  tables the archive declared.
- A zero-byte backup is deleted rather than kept as a plausible-looking file.
- Exit status is `0` only when every assertion passed.

## Tests

Two kinds, and they are not interchangeable:

| Kind | Where | What it proves |
| --- | --- | --- |
| **Runtime** | `db-verify.runtime.sh` via `npm run test:db-verify` | The script is *executed* and its behaviour observed. Uses a stubbed `docker`, so no daemon, database or VPS is needed. Covers renamed production resources, unlabelled look-alikes, failed commands and interrupted execution. Linux only; skips cleanly elsewhere. |
| **Static** | `deploy.spec.ts` | Properties of the script's *text*. Pinned so a safety rail cannot be deleted silently — for example that the destructive surface is exactly six gated call sites, and that the `contype::text` cast stays. |

Run both with `npm run test:deployment`.

## Rollback and recovery procedures

### Restoring a lost or damaged database

1. Take an immediate backup of whatever is still there, even if it looks wrong.
2. Restore into an isolated instance with Procedure 2 and inspect it. Never
   restore directly over production.
3. If it verifies, plan a cutover with the owner. Restoring over production means
   `pg_restore` against the live database and a restart of the API and worker —
   this is **not** part of these procedures and needs its own approval and window.
4. If it does not verify, fall back to an earlier backup. Compare checksums first.

### Rolling back after a schema change

Migrations are applied by an operator with `prisma migrate deploy` from a
controlled environment, never by the deployment pipeline
(`infrastructure/migrations-reviewed.json` gates which migrations may ship). Take
a backup immediately before any manual migration. Prisma records applied
migrations in `_prisma_migrations`; a restore returns that table to its
pre-migration state.

### Redis

Redis holds work in flight, never a business fact (ADR 0003). Losing Redis loses
queued work, which must be reconstructible from PostgreSQL. There is no Redis
restore procedure because there is no Redis data worth restoring at present
(`DBSIZE=0`); re-enqueue from PostgreSQL instead.

## Outstanding risks

1. **Redis has no authentication.** `requirepass` is empty and
   `protected-mode` is `no`, so Redis warns at startup that it "does not require
   authentication and is not protected by network restrictions". Safe today only
   because the host publish is loopback-bound and no other container shares its
   network. Any future container joining `truevine-voice_default` gets
   unauthenticated full read/write.
2. **PostgreSQL local and loopback authentication is `trust`.** The official image
   generates `host all all 127.0.0.1/32 trust`, so any local OS account can
   connect as any role without a password. Non-loopback connections correctly
   require `scram-sha-256`. Compounded by password-based SSH still being enabled
   on the host.
3. **No automated backups, and none off the server.** Three manual dumps exist,
   one of which is **0 bytes** and is not a usable backup. All of them, the
   PostgreSQL volume and the Redis volume are on the same disk (`/dev/sda1`) as
   the operating system. A disk failure loses everything.
4. **The production containers have never been recreated.** Procedures 2–4 prove
   the mechanisms using temporary copies. Both production containers still show
   `RestartCount=0` since 2026-10-13, so their own restart resilience is untested.
   It is configured identically (`unless-stopped`, same mount), but that is
   inference.
5. **Production Redis has never held data.** `DBSIZE=0` and a 0-byte AOF
   increment file. The configuration is proven; no real queue payload has ever
   been recovered.
6. **The datastore is defined by a file labelled for local development.**
   `/var/www/TruevineVoice/docker-compose.yml` is what production runs, and
   `production-deployment.md` explicitly warns not to run that file in production
   because its credentials are public placeholders. It is also an untracked copy
   sitting at the application root rather than a deployment artefact.
7. **No point-in-time recovery.** Backups are point-in-time dumps only; there is
   no WAL archiving, so recovery is limited to the age of the newest dump.
8. **The database holds no tenant data** (`organizations=0`), so all row-level
   fidelity evidence is schema-and-migration only.
9. **`db-verify.sh` has never run against the live VPS.** Its logic was verified
   by the procedures above and by runtime tests against a stubbed `docker`, but
   its first real execution is still ahead. Production resource *names* are
   configured constants (`PROD_CONTAINERS`, `PROD_VOLUMES`); identity checks
   would still hold after a rename, but the constants would need updating for
   `preflight` and the backup step to find the containers at all.

Items 1–3 and 7 are hardening work. Item 4 is a deliberate remaining gap: it
needs a brief datastore outage and its own approval.