# Off-site encrypted backups

Nightly, encrypted, off-site backups of the Truevine Voice production
PostgreSQL database, plus the configuration that exists **only** on the VPS.

Everything here is implemented and tested locally. **Nothing is activated.**
See [Activation](#activation--not-done) for what remains before this can run in
production.

---

## How it works

```
pg_dump -Fc  ──►  age encrypt  ──►  upload ciphertext  ──►  S3-compatible bucket
 (on the VPS)     (on the VPS)        (only ciphertext          (PutObject +
                                       ever leaves)             GetObject only)
```

Encryption happens **on the VPS, before any network egress**. The bucket only
ever receives ciphertext. There is no code path that uploads a plaintext dump.

A plaintext dump never outlives the upload in the same run: it is deleted as
soon as it is encrypted.

### What is captured

| Item                               | Contents                                                                | Encrypted                      |
| ---------------------------------- | ----------------------------------------------------------------------- | ------------------------------ |
| `prod/postgres/<ts>.dump.age`      | `pg_dump -Fc` of the production database                                | yes                            |
| `prod/postgres/<ts>.manifest.json` | timestamp, byte size, sha256 of **dump and ciphertext**, format, cipher | no (metadata only, no secrets) |
| `prod/config/<ts>.tar.gz.age`      | `deployment.json`, Docker object metadata, these scripts                | yes                            |

### What is deliberately **not** captured

| Excluded                                  | Why                                                          |
| ----------------------------------------- | ------------------------------------------------------------ |
| `.env`                                    | holds the live `DATABASE_URL` and `REDIS_URL`                |
| `.env.example`                            | public placeholder text already in Git; no recovery value    |
| `docker-compose.yml`, `infrastructure/**` | tracked in Git, so GitHub is already an off-site copy        |
| `*.test.sh`                               | test fixtures deliberately contain credential-shaped strings |
| SSH keys, PM2 dumps, `releases/`          | credential-bearing, or large and regenerable                 |

The rule is: **capture what exists only on this host.** `deployment.json` is the
one configuration file that lives only on the VPS; the Docker object inventory
(names, images, ports, volumes, mounts) is generated at backup time and is not
in Git anywhere.

`docker-compose.yml` is excluded for a second reason: it carries a committed
`POSTGRES_PASSWORD`, so bundling it would make the secret gate below fail every
single night.

---

## The secret gate

Before the configuration archive is uploaded, `assert_no_secrets` scans the
bundle and **aborts the run** if it finds anything credential-shaped: private
keys, connection strings with embedded passwords, or assignments to names
containing `PASSWORD` / `SECRET` / `TOKEN` / `API_KEY` / `ACCESS_KEY` /
`PRIVATE_KEY`, in dotenv, YAML or JSON form.

This is defence in depth. The archive is encrypted regardless, so the bucket
never sees plaintext. The gate exists so that a **new** credential appearing in
the bundle stops the run for a human to review, rather than being silently
shipped off-box under encryption.

The gate never prints the value it found — only the filename.

---

## Retention

The library contains a tested pure function that calculates the target policy of
7 daily, 4 weekly and 3 monthly backups. `backup.sh` has no object deletion path,
and the current flat timestamp keys do not let R2 age-based lifecycle rules
select exactly those counts. The function is not invoked by the backup script,
so this policy is not active. The R2 setup runbook proposes an age-based expiry
of at least 100 days as an interim option, subject to operator approval.

Do not configure an expiry shorter than the approved recovery horizon. If exact
count-based retention is required, it needs a separately reviewed pruning
mechanism and a credential whose delete capability is isolated from the nightly
uploader.

---

## Failure detection

A backup that fails quietly is worse than no backup, because it is believed to
exist. Two signals are produced:

**Exit code.** Distinct per stage, so a monitor can tell "PostgreSQL was
unreachable" from "the upload failed":

| Code | Meaning                                                                 |
| ---- | ----------------------------------------------------------------------- |
| 0    | success                                                                 |
| 1    | usage error                                                             |
| 2    | precondition failure (bad config, world-readable key, secret in bundle) |
| 3    | `pg_dump` failed                                                        |
| 4    | encryption failed                                                       |
| 5    | upload failed                                                           |
| 6    | verification failed (checksum, decryption, restore)                     |

**Status file.** Set `BACKUP_STATUS_FILE` and the run writes JSON there:

```json
{
  "timestamp": "20261016T040914Z",
  "state": "ok",
  "exit_code": 0,
  "dump_bytes": 6126,
  "cipher_bytes": 4180,
  "store": "s3"
}
```

A run that aborts part-way records `"state": "failed"` with the exit code, from
an `EXIT` handler, so a monitor that only reads this file still learns that the
nightly job did not succeed.

**Logging.** Every line goes to stderr with a redaction filter applied inside
the logging function, so a future `echo` cannot leak a key or a DSN. Set
`BACKUP_LOG_FILE` to also append to a file.

Without `BACKUP_STATUS_FILE` the status is written into the staging directory,
which is deleted on exit. That path is for debugging a live run, not monitoring.

---

## The restore command

This is the documented, tested procedure.

Scripts are committed without the executable bit, matching every other shell
script in this repository, so they are invoked through `bash`.

### Verify a backup without touching any database (the default)

```bash
export BACKUP_KEYFILE=/etc/truevine/backup.key
export BACKUP_STORE=s3
export BACKUP_BUCKET=truevine-backups

bash infrastructure/backup/restore.sh --latest
```

Output ends with:

```
[INFO] VERIFY OK: 20261016T040914Z decrypts, matches its manifest sha256, and is a valid archive
[INFO] no database was touched. Re-run with --restore to restore into an isolated instance.
```

This downloads, checksums, decrypts, verifies, and inspects the archive table of
contents. It creates nothing and leaves nothing behind.

Two **independent** checks run against the manifest recorded at backup time:

| Check                                       | Guards against                           |
| ------------------------------------------- | ---------------------------------------- |
| `cipher_sha256` — the downloaded ciphertext | truncated or corrupted object in transit |
| `dump_sha256` — the decrypted dump          | a swapped or altered payload             |

A manifest that lacks `cipher_sha256` is rejected rather than trusted.

The decrypted dump is **removed from disk on every exit path** — verify-only,
successful restore, and failure. An auto-created staging directory is deleted
when the script exits.

### If `pg_restore` cannot read the archive

Verify-only also asks the local `pg_restore` to list the archive's table of
contents. That check is **advisory when the local client is incompatible**, and
this distinction was added because a real incident forced it:

- A PostgreSQL 18 dump read by an older client exits non-zero. This is not
  corruption; it is a version mismatch. Ubuntu 24.04 ships `postgresql-client`
  16, so this happens on any CI runner or operator box that has not been
  upgraded to match the server.
- Treating that as damage made a healthy backup report
  `archive table of contents is empty or unreadable` and exit 6. The most
  damaging thing a backup tool can do is make a good backup look unrestorable.

So the two cases are separated by `pg_restore`'s **exit status**:

| `pg_restore` result    | Meaning                              | Outcome                    |
| ---------------------- | ------------------------------------ | -------------------------- |
| exit 0, objects listed | client is compatible                 | entries counted and logged |
| exit 0, **no objects** | the dump itself is defective         | **fails, exit 6**          |
| exit non-zero          | local client cannot read the archive | **warns, continues**       |

Integrity does not depend on the local client. `age` authenticates the
ciphertext, and the decrypted bytes match `dump_sha256` recorded at backup
time, so the archive is byte-for-byte what `pg_dump` produced. The
authoritative readability proof is `restore.sh --latest --restore`, which runs
`pg_restore` inside the matching PostgreSQL image.

> Restoring on the VPS needs a `pg_restore` that matches the server version, or
> the `--restore` path must point `BACKUP_PG_IMAGE` at the matching image. The
> isolated restore already defaults to `postgres:18-alpine`, so it does this
> automatically.

### Restore into an isolated instance and prove the data is intact

```bash
bash infrastructure/backup/restore.sh --latest --restore
```

Creates a **throwaway, network-isolated** container (`--network none`), its own
labelled volume, restores into it, reports the table count, then discards it.
**Production is never touched.**

### List what is available

```bash
bash infrastructure/backup/restore.sh --list
```

### Restoring over production

There is deliberately **no** option for this. Restoring over the live database
discards every write made since the backup was taken, and is a separate,
supervised operation with its own approval and its own runbook entry. Adding it
as a flag here would make an unreviewed production overwrite a single command
away.

---

## Key custody

The age identity file is the only thing that can decrypt the backups. If it is
lost, **every backup is permanently unreadable.**

- Generated with `age-keygen`, stored **mode 600**, owned by the approved job identity.
- **Both** scripts refuse to run if the key file is readable by group or other.
- The private key never appears in a log, in `stdout`, or in the bucket. A
  redaction filter is applied to every log line as a backstop.
- **Two offline copies**, held in separate physical locations, by two different
  people.
- A restore drill from an offline copy is the only way to prove a copy is good.

### Generating a key

```bash
umask 077
age-keygen -o /etc/truevine/backup.key
chmod 600 /etc/truevine/backup.key
```

This has **not** been run. No key exists anywhere yet.

---

## Storage

Cloudflare R2 is the selected provider. The implementation already supports
S3-compatible storage. Configure `BACKUP_STORE=s3`,
`BACKUP_S3_ENDPOINT=https://<ACCOUNT_ID>.r2.cloudflarestorage.com`, and
`AWS_DEFAULT_REGION=auto`. Use a private bucket with public access disabled and
server-side encryption enabled. See the [R2 setup runbook](../../docs/runbooks/r2-backup-setup.md).

The job credential must be scoped to this one bucket and needs object read,
write, and list for uploads, post-upload download/checksum verification, `HEAD`,
and `--latest` listing. Do not grant bucket administration. R2 Object Read &
Write may allow broader writes than the script uses; verify deletion semantics
and review bucket-lock protection before issuing the credential. The script
contains no object-deletion path.

The 7-daily / 4-weekly / 3-monthly helper is a tested retention calculation,
not active pruning. Age-based R2 lifecycle rules over flat timestamp keys cannot
implement those exact tiers. The R2 runbook proposes at least 100 days of age
expiry until a separately reviewed count-based retention process exists.

### Cost

Cloudflare currently lists R2 Standard at $0.015 per GB-month, with a 10-GB-month
monthly free storage tier, 1 million free Class A operations, 10 million free
Class B operations, and no R2 egress charge. At 100 GB-month of retained data,
Standard storage is approximately $1.35/month after the 10-GB-month free tier, before account-specific taxes or terms; measure actual encrypted daily bytes and the chosen retention horizon.
See [Cloudflare R2 pricing](https://developers.cloudflare.com/r2/pricing/).

The prior 7/4/3 byte estimates described a target retention policy that is not
implemented. They should not be used for budget approval until a retention
mechanism is selected.

---

## Running the tests

Static coverage — runs anywhere, including Windows, no Docker:

```bash
npx vitest run --config infrastructure/vitest.config.mts
```

Runtime coverage — executes `backup.sh` and `restore.sh` against a real
PostgreSQL instance, a real age key, and a real store. Needs Linux, `age`, and
a container runtime:

```bash
npm run test:backup
```

The runtime suite proves, end to end:

- a backup completes and the store contains **no plaintext**
- the configuration archive is **encrypted**, and no `.tar.gz` is uploaded
- verify-only restore touches no database
- restore into an isolated instance reproduces the seeded tables
- the isolated restore contains the exact seeded row counts before cleanup
- a **wrong key** fails with exit 6 and says so
- a **tampered object** is rejected
- a **manifest that does not match its object** is rejected — the check is real,
  not a self-comparison
- an **older `pg_restore` that cannot read the archive** warns and continues,
  while a dump that genuinely contains no objects still fails
- the secret gate blocks a bundle containing a credential, and does not print it
- the retention policy keeps the right set
- no key material or DSN reaches the log
- **no plaintext dump and no staging directory survives a run**
- the status file records `ok`, and records `failed` with the exit code when the
  run aborts
- the captured object metadata is valid, structured JSON, contains
  `deployment.json`, and contains no `.env`

Docker-backed cases skip **with a printed reason** when no container runtime is
present; they never pass silently.

### How the runtime suite is run

`backup.test.sh` needs Linux, `age` (which provides `age-keygen`), Node,
coreutils, and a working container runtime.

| Where                         | `BACKUP_TESTS_REQUIRED` | Missing dependency          |
| ----------------------------- | ----------------------- | --------------------------- |
| Developer workstation         | unset                   | skips with a printed reason |
| GitHub Actions unit-tests job | `1`                     | **fails the job**           |

This distinction exists because of a real defect. CI originally reported
`Unit tests: pass` while sections 3–14 — encryption, upload/download, isolated
restore, wrong key, tampering, mismatched manifest, secret gate, staging
hygiene, status file and metadata — never ran, because `age` was not installed on
the runner. The skip was printed, but the job still succeeded, so nothing
noticed.

The CI job now installs `age` **and** sets `BACKUP_TESTS_REQUIRED=1`, so a runner
that has lost the toolchain goes red instead of quietly verifying nothing.

Verified locally: with `age` present the suite reports **0 skipped**; with `age`
removed and `BACKUP_TESTS_REQUIRED=1` it **fails**, so the guard is not vacuous.

The suite has been executed against a real Linux environment with `age` 1.3.2,
Node 24 and a live container runtime: **15 sections, 0 skipped.**

---

## Defects found and fixed during verification

Recorded because each was a silent failure, not a crash.

| Defect                                                                              | Consequence                                                                                                                                      | Fix                                                                                                                        |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| `restore.sh` verified the ciphertext against **its own hash**                       | A tampered or truncated object passed the "integrity check", which logged a reassuring `sha256 verified` for a file it had checked nothing about | Manifest now records `cipher_sha256`; restore checks the object against it and rejects a manifest that cannot vouch for it |
| `restore.sh` left the **decrypted production dump** in `/tmp`, with no cleanup trap | A plaintext database persisted after every routine verification                                                                                  | `scrub_plaintext` on all three exit paths, plus an `EXIT` trap that removes an auto-created staging directory              |
| `backup.sh` also left staging behind                                                | One directory per run accumulated in `/tmp`                                                                                                      | Same trap; a caller-supplied `BACKUP_WORK_DIR` is still respected                                                          |
| `status.json` was written into the staging directory                                | The file was deleted with the directory and read by nobody — a status channel that did not exist                                                 | `BACKUP_STATUS_FILE` is now the real destination, and failures are recorded too                                            |
| Object metadata was pipe-joined strings in a JSON array                             | Usable only by eye; not reconstructible                                                                                                          | Structured JSON objects, and the result is parsed back to confirm it is valid                                              |

Each fix has a regression test. The anti-tautology guard in `backup.spec.ts` was
itself mutation-checked: it matches the original defect and does not match either
fixed form.

One **test** defect was also found and fixed: the `deployment.json` capture path
had never been exercised by a _successful_ backup, because the only fixture in
place was the credential-bearing one that the secret gate correctly rejects.

---

## Activation - not done

Cloudflare R2 is the selected provider, but nothing below has been performed.
Each production setup/write step requires separate explicit approval.

1. Create a private Cloudflare R2 bucket with public access disabled and
   server-side encryption enabled. Confirm the account and bucket jurisdiction.
2. Decide whether to add an R2 bucket lock and reconcile its minimum retention
   with lifecycle expiry. Keep bucket administration separate from the job token.
3. Generate the age identity on an authorized host, mode 600; make and test two
   separately held offline recovery copies.
4. Create a bucket-scoped R2 Object Read & Write token for the job. It needs
   upload, download/HEAD verification, and list operations. Verify its exact
   delete capability; the script itself has no object-delete path.
5. Approve the retention policy. The 7/4/3 helper is not active pruning and the
   current flat timestamp prefixes cannot implement those counts with R2 age
   lifecycle. See the R2 setup runbook for the 100-day initial proposal.
6. Store R2 credentials and the age identity outside Git and `.env`, in the
   approved VPS secret location. Configure only `backup.env` and the R2 endpoint.
7. After separate approval, run a manual encrypted backup, verify both hashes,
   and restore into the isolated disposable database using an offline age copy.
8. Only after a successful restore drill, separately approve and add the systemd
   service/timer plus a monitoring/alert path.
9. Update the recovery inventory with bucket jurisdiction, key custodians,
   retention, restore evidence, timer and alert owner.

### Known limitation

The backup script records success/failure to `BACKUP_STATUS_FILE`, but no
production schedule or alert is active. A backup that has not been restored is
not proven recoverable. Do not report backup readiness until the isolated restore
has succeeded and schedule freshness is monitored.

### Decisions still needed before activation

| Decision                                                               | Owner    | Blocks                  |
| ---------------------------------------------------------------------- | -------- | ----------------------- |
| Cloudflare account/bucket owner and jurisdiction                       | operator | bucket creation         |
| Bucket-lock policy and exact token delete capability                   | operator | credential issuance     |
| Two offline age-key custodians                                         | operator | restore readiness       |
| Age-based retention horizon or separately funded count-based design    | operator | lifecycle configuration |
| VPS approval for key, credentials, systemd timer and restore rehearsal | operator | production activation   |

### Credentials required on the VPS (never in Git, never in `.env`)

| Variable                                                                       | Value                                                                                 |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| `BACKUP_KEYFILE`                                                               | mode-600 age identity path                                                            |
| `BACKUP_STORE`                                                                 | `s3`                                                                                  |
| `BACKUP_BUCKET`                                                                | R2 bucket name                                                                        |
| `BACKUP_S3_ENDPOINT`                                                           | `https://<ACCOUNT_ID>.r2.cloudflarestorage.com` or the matching jurisdiction endpoint |
| `AWS_DEFAULT_REGION`                                                           | `auto`                                                                                |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`                                  | bucket-scoped R2 Object Read & Write token values                                     |
| `BACKUP_STATUS_FILE` and `BACKUP_LOG_FILE` should point outside the repository |
| so monitoring and log retention can see them.                                  |
