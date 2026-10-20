# Production deployment runbook

Target: Ubuntu VPS `169.58.162.143`, application root `/var/www/TruevineVoice`.
Customer URL: `https://voice.truevinecloud.online/`.

The 2026-10-14 audit confirmed the existing public customer route `/` and
`/health`; it did not confirm any public admin route. The admin app serves under
its own `/admin` basePath on loopback only (see below). Preserve the existing
routes and Nginx/TLS. A 2026-10-18 read-only routing check confirmed the same,
and confirmed that browser API traffic belongs on `/api/*` on the customer host,
proxied to the web app; the API has no `/api` prefix of its own.
The deployment account uses `/opt/truevine-runtime/bin` for the exact Node/npm pins.
The owner authorized restricting `.env` access to root and the deployment group;
its content remains unchanged. The legacy checkout and its local admin configuration
backup are retained for recovery and are never used as release input.

## Prerequisites and audit

Do these read-only checks in a trusted administrator SSH session. Do not print
`.env`, `pm2 jlist`, `pm2 env`, or PM2 dump files: they may contain secrets.

```bash
cd /var/www/TruevineVoice
git status --short
git rev-parse HEAD
node --version
npm --version
command -v pm2
pm2 --version
pm2 ls
stat -c '%a %U %G' .env
sudo nginx -t
sudo ls -l /etc/nginx/sites-enabled
sudo ss -ltnp
```

### Read-only Prisma migration inspection (after authorized SSH is restored)

This command reads the active release's migration files and PostgreSQL
`_prisma_migrations` ledger. It does not apply, resolve, reset, or modify
migrations. Run it only after connecting through the authorized SSH identity,
from the deployed release whose SHA was recorded in the preceding audit. Do not
print `.env` or pass its URL as a command-line argument:

```bash
cd /var/www/TruevineVoice/current
env -u DATABASE_URL npm run prisma:migrate:status
```

The root script delegates to the database workspace's `prisma migrate status`.
It reports migration-file and database ledger status without applying migrations.
The Prisma config loads the release's shared `.env` symlink, while `env -u`
prevents an inherited shell value from overriding it. Capture only the command's
migration names/status and exit code in the audit record. Inspect the raw output
privately: Prisma diagnostics can include database connection metadata. A nonzero
exit can indicate pending or failed migrations, divergent history, or a connection
failure; inspect the diagnostic rather than assuming the schema is current.
If the command cannot connect or its release context is unclear, stop;
do not substitute `migrate deploy`, `migrate resolve`, `db push`, or a direct SQL update.

Review `sudo nginx -T` **privately on the server**; it can contain sensitive
configuration. Record existing virtual hosts, upstreams, API path rewriting,
TLS certificate paths, access controls, and the PM2 owning OS account. Inspect
other service supervisors and other users' PM2 instances; a deploy account's
`pm2 ls` does not show root's processes. Inspect the firewall and database/Redis
bindings. No database or Redis port should be publicly reachable. Do not run the
repository's development Compose file in production: its credentials are public
placeholders. Keep existing production databases, volumes and credentials.

The repository defines no admin hostname, public admin route, Nginx
configuration, or admin authentication. The admin app sets its own `/admin`
`basePath` and listens on `127.0.0.1:3002`. Publishing it needs a separately
reviewed Nginx change and an authentication decision first. Keep admin on
loopback and access it through an SSH tunnel. There is no admin authentication.

Node must be exactly `24.19.0`, npm exactly `11.17.0`. Install those through the
server's established package management procedure; make `node`, `npm`, `bash`,
`flock`, `tar`, `git`, and the existing PM2 installation available to noninteractive
SSH. Do not upgrade PM2 implicitly in a deployment. Record its installed version.
The deploy account needs outbound access to npm and Prisma engine downloads.

## Deployment account and directories

Use an existing non-root service account when it already owns the application.
Otherwise an administrator can create a dedicated `truevine-deploy` account and
install its public SSH key; the workflow must not use root. No sudo, Docker-group
membership or database administration permissions are needed by the pipeline.

```bash
sudo adduser --disabled-password --gecos '' truevine-deploy
sudo install -d -m 700 -o truevine-deploy -g truevine-deploy /home/truevine-deploy/.ssh
# Install the public key locally into authorized_keys (mode 600), with
# restrict,no-agent-forwarding,no-port-forwarding,no-X11-forwarding,no-pty.
sudo install -d -m 750 -o truevine-deploy -g truevine-deploy \
  /var/www/TruevineVoice/incoming /var/www/TruevineVoice/releases
sudo install -m 600 -o truevine-deploy -g truevine-deploy /dev/null \
  /var/www/TruevineVoice/.deployment.lock
```

These commands are for **new** account/directories/lock only; inspect existing
objects before running them. Grant the account write access to the application
root for the `current` link and read access to the existing Git metadata through
your audited ownership/ACL policy. Do not recursively chown the application.
If Git reports dubious ownership, after verifying this exact checkout is trusted,
configure only this directory for the service account:

```bash
git config --global --add safe.directory /var/www/TruevineVoice
```

Do not use a wildcard safe.directory.

The existing `/var/www/TruevineVoice/.env` stays in place, with its content,
ownership and permissions unchanged. It must be readable by the deployment
account and have mode 600 or 640. If it is root-owned 600, non-root deployment is
blocked until the owner supplies an approved access arrangement. The pipeline
will not chmod/chown it, replace it, source it as shell code, upload it, or create
one from `.env.example`. Do not paste it into GitHub or chat.

### Variables the RBAC-001 release requires

The RBAC-001 release makes the API refuse to boot without values the foundation
`.env` never contained. `apps/api/src/auth/auth.module.ts` resolves
`WEB_PUBLIC_URL` while Nest builds its providers, so a missing value exits the
process immediately; PM2 restarts it to its limit, nothing listens on the API
port, and HTTP verification fails with the bare message `fetch failed` before
rolling back. Add these non-secret values to `/var/www/TruevineVoice/.env`
through the same approved access arrangement as the rest of the file:

- `WEB_PUBLIC_URL` — the customer URL a password-reset or invitation link must
  point at, e.g. `https://voice.truevinecloud.online`.
- `TRUEVINE_API_URL` — the server-side API origin the Next.js web and admin apps call.
  These processes do not load the shared root `.env`: Next.js loads `.env` from
  each app's own directory. PM2 explicitly supplies this value to both apps, derived
  from `apiPort` in `deployment.json` (see
  `infrastructure/pm2/ecosystem.apps.js`). Keeping it in `.env` is harmless but
  is not what these apps rely on. Admin remains bound to `127.0.0.1:3002`;
  this API-origin setting does not publish an admin route.

`EMAIL_TRANSPORT` is optional and defaults to `none`, which records that a send
was requested without delivering it. Set it only once a provider account exists.
The pipeline still never reads, replaces or creates `.env`.

Create `/var/www/TruevineVoice/deployment.json` privately on the VPS using this
shape, replacing the API URL with the route found in the Nginx audit:

```json
{
  "webUrl": "https://voice.truevinecloud.online/",
  "apiHealthUrl": "REPLACE_WITH_CONFIRMED_HTTPS_API_HEALTH_URL",
  "apiPort": 3001,
  "adminAccess": "internal",
  "adminUrl": null
}
```

`apiPort` must match the existing API upstream/configuration; 3001 is the repository
default. `adminAccess: internal` keeps admin private and checks it over loopback.
If an established public operator URL exists, set `adminAccess: public` and its
confirmed HTTPS `adminUrl`. A public check requires the real foundation HTML and
HTTP 200, not a login redirect. If existing proxy access controls prevent the VPS
from checking that route, agree an authenticated verification mechanism before
enabling public admin deployment; do not remove the access controls.

## First cutover and rollback baseline

Automatic deployment refuses to adopt existing managed PM2 processes without a
`current` link to a verified release. Legacy checkout edits are preserved untouched.
Review/back up local changes with their owner; do not reset or clean them.
As the repository owner, ignore only server-local deployment state through the
checkout's local exclude file, so an old tracked .gitignore need not be edited:

```bash
cd /var/www/TruevineVoice
LOCAL_EXCLUDE="$(git rev-parse --git-path info/exclude)"
for entry in /incoming/ /releases/ /current '/current.*' /deployment.json /.deployment.lock; do
  grep -Fxq "$entry" "$LOCAL_EXCLUDE" || printf '%s\n' "$entry" >> "$LOCAL_EXCLUDE"
done
git status --short
```

Review any remaining changes; no application edits are ignored by these rules.
The new source .gitignore also contains these entries for future checkouts.

If no managed processes exist in any service account and ports are free, the
first explicitly approved manual deployment can proceed. On failure it removes
only newly created Truevine PM2 processes; unrelated PM2 applications are
preserved.

For an existing installation, perform one supervised cutover first:

1. Record the running commit and existing PM2/service definitions. Privately save
   the owning account's `pm2 save` dump with permissions 600 in a protected backup
   directory. Retain its old checkout and compiled assets. Do not upload this dump.
2. Select a known-good commit whose CI passed. In a separate directory under
   `releases/<40-character-SHA>-baseline`, extract that exact commit plus the reviewed
   deployment tooling. The selected commit must include these reviewed deployment
   scripts; fetch it without changing the checkout if necessary. As the service
   account, with VERIFIED_SHA set to that full CI-passed SHA:

   ```bash
   [[ "$VERIFIED_SHA" =~ ^[0-9a-f]{40}$ ]]
   BASELINE_DIR="/var/www/TruevineVoice/releases/$VERIFIED_SHA-baseline"
   test ! -e "$BASELINE_DIR"
   mkdir "$BASELINE_DIR"
   git -C /var/www/TruevineVoice archive "$VERIFIED_SHA" | tar -x -C "$BASELINE_DIR"
   cd "$BASELINE_DIR"
   ```

   Run these commands in a shell with `set -euo pipefail`. Do not copy the
   production `.env` into the source. Build:

   ```bash
   npm run ci:setup-npm
   npm ci --include=dev
   npm run prisma:generate
   npm run prisma:validate
   npm run build
   ```

3. In that release directory, link the existing environment and set revision:

   ```bash
   ln -s /var/www/TruevineVoice/.env .env
   # Set this to the actual verified full SHA, never a branch name.
   printf '%s\n' "$VERIFIED_SHA" > REVISION
   ```

4. Resolve the audited PM2 ownership and process names. This ecosystem manages
   `truevine-web`, `truevine-admin`, `truevine-api`, and `truevine-worker`. Do not
   rename/delete an unrelated process. If old processes use the same ports under
   another account, coordinate a short maintenance cutover; retain their private
   PM2 snapshot so they can be restored immediately if verification fails.
5. As the service account, in the baseline directory:

   ```bash
   # Delete ONLY the four managed names, then start them scoped to those names.
   # Do not use `pm2 startOrReload`: a reload restarts the script PM2 registered
   # first and carries its captured cwd forward, so the processes come back
   # online while still pointing at the previous release. That fails
   # verification and rolls back a healthy release. `pm2 delete all` is equally
   # wrong here — it would remove unrelated applications on the same daemon.
   pm2 delete truevine-web truevine-admin truevine-api truevine-worker
   pm2 start infrastructure/pm2/ecosystem.config.js \
      --only truevine-web,truevine-admin,truevine-api,truevine-worker --update-env
   sleep 10
   npm run deploy:verify -- /var/www/TruevineVoice/deployment.json "$VERIFIED_SHA"
   pm2 ls
   ```

   Privately verify all four PM2 processes are stable with their cwd/script in
   this baseline release. Confirm Nginx/TLS/public URLs. A managed name that was
   absent before the switch is started too; `pm2 ls` must show all four.

6. **Only after verification**, create the `current` symlink to that baseline,
   write `READY` containing the SHA, and `pm2 save`:

   ```bash
   printf '%s\n' "$VERIFIED_SHA" > READY
   ln -s "$BASELINE_DIR" /var/www/TruevineVoice/current
   pm2 save
   ```

   This refuses to overwrite an existing current link. On first-cutover failure,
   restore the old supervisor definitions and old verified routing instead;
   do not mark the baseline ready. This initial adoption is intentionally supervised.

An administrator should configure the service account's PM2 systemd startup
using `pm2 startup` and its generated command (review paths/user first), then
`pm2 save`. Check `systemctl status pm2-<account>`. The CI account receives no
permission to edit Nginx or restart system services.

## GitHub configuration

Repository Settings > Secrets and variables > Actions (or the `production`
environment) needs:

| Secret                | Purpose                                                    |
| --------------------- | ---------------------------------------------------------- |
| `VPS_SSH_HOST`        | `169.58.162.143`; the workflow verifies this exact target  |
| `VPS_SSH_USER`        | Dedicated non-root application/service account             |
| `VPS_SSH_KEY`         | Private key belonging only to that deploy account          |
| `VPS_SSH_KNOWN_HOSTS` | Complete OpenSSH known_hosts line for the VPS and SSH port |

Verify the server host-key fingerprint through a trusted console or administrator
before setting known_hosts. Do not trust an unauthenticated `ssh-keyscan` result
by itself. For port 22 use the IP host entry; for another port use
`[169.58.162.143]:<port>`. Key rotation requires updating the secret after trusted
verification, not disabling StrictHostKeyChecking.

Enter secrets through GitHub's UI from your local files, or use these commands
locally after authenticating `gh`; never paste credentials into a conversation:

```bash
gh auth login
gh secret set VPS_SSH_HOST --repo Truevinecloud/TruevineVoice
gh secret set VPS_SSH_USER --repo Truevinecloud/TruevineVoice
gh secret set VPS_SSH_KEY --repo Truevinecloud/TruevineVoice < /secure/local/deploy-private-key
gh secret set VPS_SSH_KNOWN_HOSTS --repo Truevinecloud/TruevineVoice < /secure/local/verified-known-hosts
```

Set variable `VPS_SSH_PORT` (default 22) and `DEPLOYMENT_READY=true` only after
the VPS, baseline and routing checks above pass. The production workflow is
manual-only: merging to `main` or successful CI does not start deployment. An
authorized operator must dispatch `deploy.yml` with `authorize_production=true`
after reviewing the exact SHA, migration approvals, backup/restore evidence and
release runbook. Configure the `production` GitHub environment to permit only
`main` and require designated reviewers as a separate defense-in-depth control;
do not treat the workflow input as a replacement for environment reviewers.
Protect `main` with all four CI job names in `ci.yml` and require reviews for
deployment-code changes. No application secrets or database passwords are
GitHub Actions inputs.

`deploy.yml` resolves a completed successful `push` CI run from this repository
for the explicitly approved current-main SHA, verifies all required jobs, and
refuses a superseded commit. It does not run from PR artifacts. A future release
requires separate explicit approval; this workflow change itself does not
authorize a production deployment.

## Routing and TLS

Keep existing valid certificates and HTTPS server blocks. After auditing them,
only the confirmed customer's existing location needs to proxy to
`http://127.0.0.1:3000`. Keep its normal proxy headers (`Host`,
`X-Real-IP`, `X-Forwarded-For`, `X-Forwarded-Proto`) and existing security settings.
`/health` reaches the NestJS service on its existing route/upstream. Browser API
traffic is not served from the API's own route: it uses `/api/*` on the customer
host, which must proxy to the web app (`127.0.0.1:3000`) so the app's
same-origin proxy forwards it to the NestJS service and applies its route
allowlist. The API has no `/api` prefix of its own. Do not silently expose admin
or invent another domain.

Before any separately reviewed Nginx change, back up the exact relevant config
privately, run `sudo nginx -t`, and only then `sudo systemctl reload nginx`.
Preserve certificate renewal configuration and other virtual hosts. No Nginx
configuration is overwritten by the pipeline.

| Service            | Binding                                         | Public route                                                                                 |
| ------------------ | ----------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Customer Next.js   | `127.0.0.1:3000`                                | `https://voice.truevinecloud.online/`                                                        |
| Admin Next.js      | `127.0.0.1:3002`                                | None; internal only, loopback/SSH tunnel (no admin auth exists)                              |
| NestJS API         | `127.0.0.1:<apiPort>` (default 3001)            | `GET /health`; browser API traffic via `/api/*` on the customer host, proxied to the web app |
| NestJS worker      | No HTTP port                                    | None; PM2 stability plus API Redis health are verified                                       |
| PostgreSQL / Redis | Existing private/loopback endpoints from `.env` | None                                                                                         |

## Routine deployment and failures

A source archive of the CI-tested SHA is transferred using pinned host keys,
then built on Ubuntu in `incoming`. Builds complete before PM2 activation. The
pipeline uses the actual root build script, checks all four build outputs, links
`.env`, and switches the four managed processes by deleting those exact names
and starting the explicit ecosystem scoped to them. `APP_VERSION` reports the SHA.
It verifies local web/admin/API, public web/API, any confirmed public admin,
and PM2 uptime/cwd/version for all four processes. `current` switches atomically
only after those checks pass, then PM2 state is saved. Both workflow concurrency
and server-side `flock` serialize activation and rollback.

### Explicitly approved deployment

Merging or pushing to `main`, and successful CI completion, do not start
production deployment. After the release approver has reviewed the exact current
main SHA, passing CI, migration approvals, backup/restore evidence and recovery
plan, an authorized repository operator can dispatch **Production deployment**
with `authorize_production=true`. The default is `false`; without the explicit
input the job does not run. It resolves a completed successful `push` CI run for
that exact SHA and still refuses a commit that is not the tip of `main`.
GitHub's `production` environment should independently require designated
reviewers and allow only `main`; configuring those live settings is a separate
operator action and is not part of the workflow code change.
The switch deletes and restarts only the four managed processes; unrelated PM2
applications on the deployment account's daemon are never touched. Process
restarts briefly interrupt each application; this is not a zero-downtime
blue/green deployment. Compilation does not interrupt the active release. A
failed build leaves live processes untouched. Activation/check/save failure
restores and verifies the previous release and still fails the job. If recovery
also fails, the job explicitly fails and needs an operator. Interruption such as
a lost SSH connection/power failure requires inspecting `pm2 ls`, `current`, and
public health before retrying; no system can run an in-process rollback after
being killed. The retained releases and lock support supervised recovery.

Deploy never runs development migrations, reset, db push or Compose teardown.
The migration manifest must exactly match the release migration directories.
After build and approval checks, deployment runs `npm run prisma:migrate:deploy`
using DATABASE_URL from the shared production .env, before touching PM2 or current.
Prisma output is captured to keep connection details out of CI logs. A nonzero
exit or timeout fails deployment without activating the candidate or restarting
the baseline. Inspect the migration state securely before retrying.

Approval requires SQL review, backward compatibility with the active release,
a rehearsed backup and a recovery plan. Migration failure can leave partial schema
changes; code rollback does not undo SQL. Explicit code rollback does not run
migrations. See [ADR 0011](../adr/0011-reviewed-deployment-migrations.md).

See [ADR 0006](../../docs/adr/0006-tenancy-core-schema.md).

## Rollback

As the dedicated service account, select a previous **READY** release's full SHA:

```bash
cd /var/www/TruevineVoice/current
npm run deploy:rollback -- <previous-verified-40-character-SHA>
```

Rollback uses the same lock, explicit PM2 definitions and all health checks,
without dependency installation, rebuild, Git operations or database changes.
It saves PM2 only after verification. If the rollback candidate fails, it attempts
to restore the previously active release and fails the command. Retain one READY
release per SHA (duplicate SHA releases require an operator to disambiguate).

After deployment/rollback, independently verify the agreed public web URL and
API URL from another machine. Confirm `/health` returns `status: ok`, both
dependencies `up`, `environment: production`, and `version` equal to the selected
SHA. Keep disk-space monitoring; releases are intentionally not auto-pruned.
Remove old releases only through an audited retention procedure that excludes
`current`, the rollback target, and production configuration/data.
