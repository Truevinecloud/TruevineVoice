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

**7 daily, 4 weekly, 3 monthly**, enforced by **bucket lifecycle rules**, not
by the script.

The backup scripts contain no delete path at all — no `s3 rm`, no
`delete-object`, no `aws s3api delete-objects`. A script that deletes backups
cannot be reasoned about afterwards, and a compromised nightly job with delete
rights could destroy the very history it is supposed to protect. Expiry is a
property of the bucket, reviewed as configuration rather than executed as code.

`retention_keep_set()` in `lib/common.sh` implements the same policy as a pure,
tested function. It exists so the policy can be unit-tested and reasoned about;
it is not invoked by `backup.sh`.

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

- Generated with `age-keygen`, stored **mode 600**, owned by the backup user.
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

An S3-compatible bucket, created by a human, with:

- **Object encryption at rest enabled** (defence in depth — objects are already
  encrypted client-side with age).
- **Versioning enabled**, so an accidental overwrite is recoverable.
- **Lifecycle rules** implementing 7 daily / 4 weekly / 3 monthly expiry.
- A credential with **`PutObject` and `GetObject` only — no `DeleteObject`.**
  The scripts never delete, so it does not need the permission. Removing it
  means a compromised backup job cannot destroy history.

### Cost

Pricing verified **16 October 2026** against each provider's published page.

| Provider          | Storage           | Free tier   | Egress               | Lifecycle delete |
| ----------------- | ----------------- | ----------- | -------------------- | ---------------- |
| **Cloudflare R2** | $0.015 / GB-month | 10 GB-month | **Free, unlimited**  | Free             |
| Backblaze B2      | $6.95 / TB-month  | first 10 GB | Free up to 3× stored | Free (Class C)   |

Nightly operation volume is negligible against both free tiers: 3 `PutObject`
calls per night (dump, manifest, config) ≈ **90 Class A operations/month**,
plus ≈30 `GetObject` from the post-upload verification — against free allowances
of 1 million and 10 million respectively.

**What actually costs money is retained bytes, not run frequency.** Retention
holds ~14 objects (7 daily + 4 weekly + 3 monthly, with overlap), so:

| Dump size                           | Retained | R2           | B2           |
| ----------------------------------- | -------- | ------------ | ------------ |
| 13 KB (measured now, 3 tables)      | ~180 KB  | **$0.00**    | **$0.00**    |
| 10 MB (conservative MVP projection) | ~140 MB  | **$0.00**    | **$0.00**    |
| 100 MB                              | ~1.4 GB  | **$0.00**    | **$0.00**    |
| 700 MB                              | ~9.8 GB  | **$0.00**    | **$0.00**    |
| 1 GB                                | ~14 GB   | ~$0.06/month | ~$0.10/month |
| 10 GB                               | ~140 GB  | ~$1.95/month | ~$0.98/month |

**Free until a dump exceeds roughly 700 MB**, which at MVP growth is years away.
Neither provider charges for the lifecycle deletions that expire old backups,
so the 7/4/3 policy costs nothing to enforce.

**Recommendation: Cloudflare R2**, on one specific ground: **egress is free and
unlimited**. A recovery drill downloads the whole archive, and that is precisely
where per-GB egress billing surprises people. B2 covers egress up to 3× stored
(also enough here) and adds **Object Lock / WORM immutability**, which R2 does
not offer.

**Open decision:** if ransomware-resistant, legally provable immutability is
required, B2's Object Lock is the reason to choose it over R2, at comparable
price. That choice needs a human. Hetzner Object Storage was **not** evaluated
and its pricing is unverified.

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
- a **wrong key** fails with exit 6 and says so
- a **tampered object** is rejected
- a **manifest that does not match its object** is rejected — the check is real,
  not a self-comparison
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

## Activation — not done

Nothing below has been performed. Each step needs explicit approval.

1. **Decide the provider** (R2 vs B2 vs Hetzner) and whether Object Lock is
   required.
2. **Create the bucket** with versioning, lifecycle rules, and server-side
   encryption. Requires an account; **no paid resource has been created.**
3. **Generate the age key** on the VPS, mode 600.
4. **Make two offline copies**, in two places, held by two people.
5. **Verify both copies decrypt** — a copy nobody has tested is not a copy.
6. **Create the bucket credential** with `PutObject` + `GetObject` only, and
   store it on the VPS outside the repository and outside `.env`.
7. **Run one manual backup and one manual restore** end to end, from an offline
   key copy. This is a gate: it must pass before anything is scheduled.
8. **Add the systemd service and timer** for the nightly run.
9. **Add a weekly restore test** that verifies freshness and decryptability
   automatically, so a silently failing backup is noticed within days rather
   than at restore time.
10. **Update the recovery runbook** with the off-site procedure.

### Known limitation

A backup that is never restored is not a backup. Until step 9 exists, a
nightly failure would go unnoticed until someone needed the data. The nightly
job logs, exits non-zero, and writes `"state": "failed"` to `BACKUP_STATUS_FILE`
when that is configured — but nothing currently **alerts** on it. Step 9 is the
fix and is the highest-value item on this list.

### Decisions and approvals needed before activation

| #   | Decision                                                                                                                                                     | Owner   | Blocks |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------- | ------ |
| 1   | **R2 or B2?** R2 has free unlimited egress but no Object Lock; B2 adds WORM immutability at comparable price                                                 | founder | step 2 |
| 2   | **Create the bucket account** — requires a Cloudflare or Backblaze account and payment details. **No account has been created and no paid resource exists.** | founder | step 2 |
| 3   | **Who holds the two offline key copies**                                                                                                                     | founder | step 5 |
| 4   | **Retention confirmation** (7/4/3 assumed)                                                                                                                   | founder | step 2 |
| 5   | **VPS approval** to install the systemd service/timer                                                                                                        | founder | step 8 |

### Credentials required on the VPS (never in Git, never in `.env`)

| Variable                                      | Value                                           |
| --------------------------------------------- | ----------------------------------------------- |
| `BACKUP_KEYFILE`                              | path to the mode-600 age identity               |
| `BACKUP_STORE`                                | `s3`                                            |
| `BACKUP_BUCKET`                               | bucket name                                     |
| `BACKUP_S3_ENDPOINT`                          | R2/B2 endpoint URL                              |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | bucket credential, `PutObject`+`GetObject` only |

`BACKUP_STATUS_FILE` and `BACKUP_LOG_FILE` should point outside the repository
so monitoring and log retention can see them.
