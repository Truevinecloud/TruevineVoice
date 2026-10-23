# One-time QA Organization Owner recovery

This procedure is restricted to the existing `admin@truevoice.com` user with an
OWNER membership in `truevine-voice-qa`. It never provisions accounts, changes
roles, sets a password, clears suspension, or touches Platform Owner bootstrap.
Any platform-role assignment (including a revoked historical assignment) refuses
recovery. Missing or mismatched identity/membership fails closed.

## Production procedure (approval required; not executed during implementation)

Use the reviewed release containing this command, on the VPS, as the authorized
operator with access to its production environment. Confirm `DATABASE_URL`
targets the intended database and `WEB_PUBLIC_URL` is the trusted HTTPS customer
origin, without printing either. Load configuration using the approved server
environment mechanism; do not put credentials in arguments or shell history.
The CLI also uses the repository's existing environment-file loader.

Create a new directory outside the checkout, beneath the operator's private home:

```sh
umask 077
mkdir -m 700 "$HOME/qa-owner-recovery"
npm run recover:qa-owner -- --confirm-production --activation-directory "$HOME/qa-owner-recovery"
```

The final line is the exact recovery invocation. The flag is mandatory in every
environment, including local runs. The directory must already exist, resolve
without symlinks, belong to the effective operator UID, and have exactly `0700`
permissions. The file is opened exclusively with mode `0600` and no symlink
following. Use a private local POSIX filesystem with trusted ancestors and no
additional ACL grants. Windows is deliberately refused because mode bits do not
enforce Windows ACLs. Do not use a shared operator account, web-served directory,
automatically synced folder, or backup/log collection path.

Only the file path and expiry are printed. Read the link through an approved
private operator tool and deliver it to the verified QA account custodian over
an approved confidential channel. Do not `cat` it into a recorded terminal,
paste it in tickets, send it to this assistant, or place it in command arguments.
The link uses `/set-password` and the existing password-reset completion API.
The custodian chooses their own password. It expires after the shared reset
lifetime (currently one hour) and can be consumed only once. Existing sessions
are revoked by the existing completion mechanism when the password changes;
issuance alone does not revoke sessions or change the current password.

After verified completion, delete the private file and empty directory. Treat
the file as an account takeover credential until expiry. Deleting it does not
revoke a copied token. If exposure is suspected, repeat this reviewed procedure
to invalidate the prior unused token, then deliver the replacement securely.

## Atomicity and evidence

The command locks organization then user, rechecks identity/membership, expires
all unused password-reset tokens (activation tokens share that table), inserts a
digest from the shared generator/hash and shared expiry constant, and writes an
`auth.password_reset_requested` identity audit in one PostgreSQL transaction.
The audit has a null application actor, explicit operator-recovery source,
target user/organization IDs and OS UID, with no raw token or URL. Correlate the
UID with the approved operator session/change record; it is not an authenticated
application principal. Success audit failure rolls back token replacement.

The file is written and fsynced before commit; file failure rolls back issuance.
On transaction failure the file is removed. Filesystem and PostgreSQL cannot
commit atomically: a crash or ambiguous commit may leave an unusable file or a
valid token without a usable delivery file. No success should be inferred from
a leftover file after failure. Rerun to invalidate previous tokens and produce a
replacement. Concurrent recovery/reset requests serialize on the user lock;
only the latest issued token remains valid. A repeat invocation is deliberate
token replacement, not an irrevocably single-run script.

Focused unit tests use fakes. The required GitHub Actions E2E job additionally
runs a Linux rehearsal with a newly created disposable PostgreSQL database. It
executes the real Node CLI and checks filesystem modes, token invalidation,
unchanged identities/roles, safe audit/output, organization/user row-lock waits,
concurrent issuance, deferred commit rollback and file cleanup, late filesystem
failure rollback/retry, and existing reset consumption/session revocation/replay
refusal without email. Failure of this step fails the required E2E job.
The harness drops only the database it created. It refuses non-Linux hosts,
missing `QA_OWNER_RECOVERY_DISPOSABLE=1`, environments other than `NODE_ENV=test`,
and database URLs outside loopback Compose port 55432/database `truevine_voice`.
The configured database is used only to create/drop the new database; all
fixtures and migrations are confined to that newly generated database.
Do not migrate, deploy, or execute against production without explicit approval.

```sh
npm run test:qa-owner-recovery
npm run lint:qa-owner-recovery
# Linux, after starting the disposable local Compose stack and building packages/API:
NODE_ENV=test QA_OWNER_RECOVERY_DISPOSABLE=1 npm run test:qa-owner-recovery:linux
```

## Deployment path

Use a feature PR into `main`; require every normal CI job, including this added
E2E step. A successful PR run is preparation evidence, not a production release.
After approved merge, the existing main-push CI and production-environment
deployment workflow enforce the exact main SHA and all required checks. Do not
dispatch deployment against an unverified commit or bypass a failed check.
Recovery is a separate manual operator action and is never part of CI or deploy.
