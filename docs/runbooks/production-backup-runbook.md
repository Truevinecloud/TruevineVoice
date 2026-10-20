# Production backup preflight and first-run procedure

This runbook extends the existing `infrastructure/backup/backup.sh` and
`restore.sh` implementation. It does not authorize a production backup, storage
credential creation, systemd activation, migration, or deployment. Those remain
separate operator approvals.

## Preconditions

Before requesting approval for the first production backup, an authorized
operator must verify and record:

- SSH reaches the confirmed VPS through an existing authorized identity and
  strict known-host verification.
- The exact active release SHA and database container name; the current reported
  release is `4da51ffb948f0d96311b40edd42515441e2b9121`.
- The PostgreSQL container is healthy and the database is
  `truevine_voice`. The backup role can run `pg_dump` without schema or data
  write privileges.
- The Cloudflare R2 bucket is private, public access is disabled, the jurisdiction
  and endpoint are correct, and a bucket-scoped Object Read & Write token has
  been created. Bucket-administration credentials are kept separate.
- `/etc/truevine/backup.key` is an age identity owned by root with mode `0600`,
  and two separately held, encrypted offline recovery copies have been tested.
- `/etc/truevine/backup.env` is outside the application tree, owned by root,
  mode `0600`, and contains only the approved R2 endpoint, bucket, prefixes,
  `AWS_DEFAULT_REGION=auto`, age key path, and R2 access credentials. Never
  print or source it in an interactive shell.
- The target filesystem has free space for a full plaintext dump, ciphertext,
  and configuration archive for the duration of the run. Use the largest
  observed dump size with at least 2x headroom.
- An alert destination and named backup operator are ready. No schedule is
  active until a separately approved systemd service/timer and alert test exist.

The script needs Docker access for `docker exec pg_dump` and captures object
metadata using Docker inspection. Access to the Docker socket is effectively
root-equivalent. Until the security owner approves running this backup job with
root-equivalent privileges (or separately reviews a constrained replacement),
do not activate it. Do not add a general-purpose service account to the Docker
group as a shortcut.

An authorized operator can check metadata without displaying secrets:

```bash
sudo stat -c '%U %a %n' /etc/truevine/backup.env /etc/truevine/backup.key
df -h /var/tmp /var/www/TruevineVoice
docker inspect --format '{{.Name}} {{.State.Status}} {{.State.Health.Status}}' truevine-postgres
docker exec truevine-postgres psql -X -U truevine -d truevine_voice -Atc 'SELECT 1'
```

Confirm the actual container health fields and database role against the live
deployment before use. Do not dump environment variables, inspect secret file
contents, or run migrations as part of backup preflight.

## Explicit approval points

1. **Credential approval:** Cloudflare administrator approves bucket jurisdiction,
   retention, bucket lock, and token scope. Job-token delete semantics must be
   understood; if it can delete, rely on reviewed bucket-lock controls or do not
   issue it yet.
2. **Key custody approval:** two custodians confirm the offline recovery copies
   and the recovery drill. Loss of the age private key makes all objects
   unrecoverable.
3. **Production read/upload approval:** a named operator approves one backup
   invocation. It reads production via `pg_dump` and transmits age-encrypted
   objects and metadata to R2. It does not change PostgreSQL, but it is a
   production database read and outbound transfer.
4. **Restore approval:** a named operator approves the isolated restore drill.
   It downloads production backup objects and creates disposable local Docker
   resources on `--network none`; it never restores over the live database.
5. **Scheduling approval:** only after successful upload, checksum verification,
   isolated restore, alert verification and retention approval may a separately
   reviewed systemd unit/timer be installed and enabled.

## One-time backup and verification

Do not run these commands until approval points 1–3 above are granted and the
active release path and R2 configuration are verified. They run as root because
the current implementation requires Docker access; root-owned files and umask
`0077` keep the age identity, credentials and temporary plaintext inaccessible
to other users. Create and record the exact unit name before dispatch:

```bash
UNIT="truevine-backup-manual-$(date -u +%Y%m%dT%H%M%SZ)"
sudo systemd-run --wait --collect --unit="$UNIT" \
  --property=EnvironmentFile=/etc/truevine/backup.env \
  --property=WorkingDirectory=/var/www/TruevineVoice/current \
  --property=UMask=0077 \
  /bin/bash infrastructure/backup/backup.sh
sudo systemctl show "$UNIT" --property=Result --value
```

The example assumes `/var/www/TruevineVoice/current` is the verified release
path. It uses systemd's `EnvironmentFile` handling rather than sourcing secrets
as shell code. Set a private `BACKUP_STATUS_FILE` in `backup.env`; inspect only
its state, exit code, timestamp, dump size and ciphertext size.

After success, an operator separately approves verification and restore:

```bash
UNIT="truevine-restore-verify-$(date -u +%Y%m%dT%H%M%SZ)"
sudo systemd-run --wait --collect --unit="$UNIT" \
  --property=EnvironmentFile=/etc/truevine/backup.env \
  --property=WorkingDirectory=/var/www/TruevineVoice/current \
  --property=UMask=0077 \
  /bin/bash infrastructure/backup/restore.sh --latest
sudo systemctl show "$UNIT" --property=Result --value

UNIT="truevine-restore-drill-$(date -u +%Y%m%dT%H%M%SZ)"
sudo systemd-run --wait --collect --unit="$UNIT" \
  --property=EnvironmentFile=/etc/truevine/backup.env \
  --property=WorkingDirectory=/var/www/TruevineVoice/current \
  --property=UMask=0077 \
  /bin/bash infrastructure/backup/restore.sh --latest --restore
sudo systemctl show "$UNIT" --property=Result --value
```

Confirm both manifest hashes, `VERIFY OK`, `RESTORE VERIFIED`, and that no
container or volume with that restore run label remains. If cleanup reports an
ownership mismatch, leave those resources untouched and escalate; never remove
them by name alone.

## Retention and scheduling

The code has a tested 7-daily / 4-weekly / 3-monthly retention calculation but
does not delete objects. This policy is not active. With the current flat
timestamp keys, R2 lifecycle cannot implement exact count-based retention. The
current proposal is a reviewed minimum 100-day age expiry on `prod/postgres/`
and `prod/config/`; only a separate R2 administrator should configure it, and
only after bucket-lock duration and lifecycle behavior are reconciled. Never
grant delete capability to the backup process solely to emulate pruning.

No production schedule is currently declared active. A systemd service/timer,
status monitoring and alert delivery need a separate reviewed change. Do not
claim backup readiness based on a successful upload alone; a recent isolated
restore is required.

## Failure and recovery

- A failed `pg_dump` (exit 3), age encryption (4), upload (5), or verification
  (6) is a failed backup. Preserve its redacted logs and status file, correct the
  cause, and rerun only after confirming partial objects do not create a false
  success signal. The scripts do not delete bucket objects.
- On a restore ownership mismatch, preserve the resources for inspection. The
  script deliberately exits nonzero and refuses uncertain cleanup.
- Never restore into production from this runbook. Live recovery is a separate
  incident procedure requiring a verified backup, separate approval, an explicit
  downtime/data-loss decision, and a supervised recovery plan.
- Do not run migrations, reset, container teardown, or deployment commands during
  backup or restore verification.
