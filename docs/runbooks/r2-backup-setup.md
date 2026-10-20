# Cloudflare R2 backup setup

This runbook configures the existing `infrastructure/backup/backup.sh` and
`restore.sh` flow. It does not create a second backup system and it is a
preparation only: no bucket, credentials, VPS files, timer, or production data
were changed while preparing it.

## Data path and configuration

PostgreSQL is dumped on the VPS, encrypted there with the existing age identity,
and only then uploaded through AWS CLI's S3-compatible API. Restore downloads
the ciphertext, verifies the manifest's ciphertext and plaintext SHA-256 values,
decrypts locally, and can rehearse into a separate `--network none` PostgreSQL
container. The default R2 endpoint is `https://<ACCOUNT_ID>.r2.cloudflarestorage.com`;
use region `auto`. If the bucket uses a Cloudflare data jurisdiction, use its
jurisdiction-specific endpoint instead. See Cloudflare's [S3-compatible R2
authentication guide](https://developers.cloudflare.com/r2/api/tokens/).

Prepare a dedicated private bucket (for example `truevine-prod-backups`) in the
Cloudflare account's intended data jurisdiction. Keep public access disabled and
do not attach a public custom domain. Use the Standard storage class. Do not put
the bucket or credentials in Git.

The existing scripts need these settings in a root-owned, mode-600 file such as
`/etc/truevine/backup.env`, loaded by the future systemd service:

```dotenv
BACKUP_STORE=s3
BACKUP_BUCKET=truevine-prod-backups
BACKUP_S3_ENDPOINT=https://<ACCOUNT_ID>.r2.cloudflarestorage.com
BACKUP_KEY_PREFIX=prod/postgres
BACKUP_CONFIG_PREFIX=prod/config
BACKUP_KEYFILE=/etc/truevine/backup.key
AWS_DEFAULT_REGION=auto
AWS_ACCESS_KEY_ID=<R2_ACCESS_KEY_ID>
AWS_SECRET_ACCESS_KEY=<R2_SECRET_ACCESS_KEY>
```

The R2 endpoint, bucket, region and key prefixes are configuration, not
credentials. The access key values and age identity are secrets. Use a dedicated
R2 Account API token with **Object Read & Write** permission scoped to this one
bucket; do not use Admin Read & Write or an account-wide token. Cloudflare
describes this as object read/write/list, but its permission page does not
document a separate deny-delete option. Treat the exact `DeleteObject`
restriction as unverified until an isolated bucket test proves it. The backup and
restore code needs object read/write/list: upload, post-upload download and
checksum verification, object `HEAD`, and listing for `--latest`/`--list`.
Never grant bucket administration. Review Cloudflare's permission semantics
and use an R2 [bucket lock policy](https://developers.cloudflare.com/r2/buckets/bucket-locks/)
if appropriate before issuing the credential. Bucket locks take precedence
over lifecycle expiry, so choose compatible durations before activating either.
The backup uploader itself must not receive the Cloudflare API token used to
change bucket configuration or lifecycle rules.

The current backup implementation performs no object deletion. Its 7-daily,
4-weekly, 3-monthly helper is a tested retention calculation, not an active
pruning mechanism. R2 lifecycle rules operate on object age/prefix, so they
cannot implement that exact count-based tier policy over the current flat
timestamp key layout. For initial activation, prefer a reviewed age-expiry of
at least 100 days on both `prod/postgres/` and `prod/config/`; this keeps daily
recovery points for at least the existing three-month horizon and costs more
storage than tiered pruning. Do not set a shorter expiry or claim the 7/4/3
policy is active. If count-based retention is required, design a separate
reviewed archive/pruning process with a delete-capable credential isolated from
the backup job.

Enable Cloudflare's R2 server-side encryption at rest as defence in depth;
client-side age encryption remains the confidentiality boundary. R2 lifecycle
expiration is asynchronous, so expired objects may remain for a period after
the configured age. Consider a bucket lock only after its retention period is
reconciled with lifecycle expiration and tested on a non-production bucket.

## Secret custody and placement

- Generate one age identity on a trusted administrator workstation or the VPS
  through an approved secure procedure. Install it at `/etc/truevine/backup.key`
  owned by the approved backup job identity and mode `0600`. The current script
  requires Docker socket access, which is root-equivalent; see the production
  backup runbook before selecting an identity or granting Docker access.
- Keep two encrypted offline recovery copies in separate physical locations,
  with separate custodians. Test decryptability during a restore drill. R2
  cannot recover a lost age private key.
- Store the R2 access key ID and secret only in the root-owned mode-600
  `/etc/truevine/backup.env` on the VPS. Do not add them to GitHub Actions,
  PM2, application `.env`, command-line arguments, or logs.
- Configure an R2 bucket lifecycle rule from an administrator account separate
  from the job credential. Enable an expiry rule only after the final retention
  decision is approved.
- Keep the production deployment workflow unrelated: backup activation must
  not change the deployment environment, GitHub production variables, or
  application secrets.

## Safe activation sequence (not performed)

1. An authorized Cloudflare administrator confirms account jurisdiction, creates
   the private bucket, confirms public access is off, and records the bucket
   name and account ID in the operator's secure inventory.
2. The administrator creates a bucket-scoped Object Read & Write R2 token and
   records the one-time secret in the approved secret manager. Confirm the
   token cannot administer buckets. Reconcile its delete capability with the
   chosen bucket-lock and lifecycle controls.
3. An authorized VPS operator recovers the existing SSH identity first, then
   prepares the age key and root-only environment file using the approved
   change procedure. Do not copy production credentials into a test environment.
4. Run backup against the existing production PostgreSQL container only after
   separate approval for this production read and outbound backup operation.
   Verify that the uploader's status is `ok`, then run `restore.sh --latest`
   and `restore.sh --latest --restore` into its isolated disposable database.
5. Verify the object timestamps, both manifest checksums, configuration archive,
   logs for redaction, and a real restore. Then have an operator review the
   desired R2 age-expiry and create the systemd service/timer through a separately
   approved change. Confirm the timer and alert path before calling scheduling
   active.

## Cost and operator decisions

Cloudflare's published R2 Standard storage price is $0.015/GB-month with a
10-GB-month free storage tier and no egress charge; lifecycle deletions are not
billed as object-class operations. Cost depends on compressed database/config
size retained for at least 100 days. For example, 1 GB of daily combined backup
objects over 100 days is about 100 GB-month, approximately $1.35/month after
the 10-GB-month free tier, before tax and account-specific terms. Measure actual encrypted daily bytes before
final budget approval. See [R2 pricing](https://developers.cloudflare.com/r2/pricing/)
and [R2 object lifecycle behavior](https://developers.cloudflare.com/r2/buckets/object-lifecycles/).

## Outstanding operator decisions

- Confirm Cloudflare account, jurisdiction, bucket name and owner.
- Confirm whether Object Read & Write's delete capability is acceptable, and
  whether a bucket lock is required before issuing job credentials.
- Approve the initial 100-day age retention or request a separately reviewed
  count-based retention implementation.
- Identify the authorized VPS backup account, secret manager, alert destination,
  maintenance window and cost owner.
- Approve the production read/upload and restore rehearsal separately. This
  document itself authorizes none of those operations.
