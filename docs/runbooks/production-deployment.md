# Production deployment runbook

Target: Ubuntu VPS `169.58.162.143`, application root `/var/www/TruevineVoice`.
Customer URL: `https://voice.truevinecloud.online/`.

The 2026-10-14 audit confirmed the existing public `/health` and `/admin` routes,
including the admin app's `/admin` basePath. Preserve these routes and Nginx/TLS.
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

Review `sudo nginx -T` **privately on the server**; it can contain sensitive
configuration. Record existing virtual hosts, upstreams, API path rewriting,
TLS certificate paths, access controls, and the PM2 owning OS account. Inspect
other service supervisors and other users' PM2 instances; a deploy account's
`pm2 ls` does not show root's processes. Inspect the firewall and database/Redis
bindings. No database or Redis port should be publicly reachable. Do not run the
repository's development Compose file in production: its credentials are public
placeholders. Keep existing production databases, volumes and credentials.

The repository defines no admin hostname, admin path prefix, Nginx configuration,
or authentication. Confirm the intended operator route before publishing it.
Next.js has no `basePath`; proxying this app under `/admin` without a separately
reviewed basePath change will break its assets. Until routing is agreed, keep
admin on loopback and access it through an SSH tunnel. This does not implement
admin authentication.

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
first automatic deploy can proceed. On failure it removes only newly created
Truevine PM2 processes; unrelated PM2 applications are preserved.

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
   pm2 startOrReload infrastructure/pm2/ecosystem.config.js --update-env
   sleep 10
   npm run deploy:verify -- /var/www/TruevineVoice/deployment.json "$VERIFIED_SHA"
   pm2 ls
   ```

   Privately verify all four PM2 processes are stable with their cwd/script in
   this baseline release. Confirm Nginx/TLS/public URLs.

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

Ensure `main` is the repository default branch: workflow_run must exist on the
default branch to trigger. Set variables `VPS_SSH_PORT` (default 22) and `DEPLOYMENT_READY=true` **after** the
VPS, baseline and routing checks above pass. Configure the `production` GitHub
environment to permit only `main`. Required reviewers are optional; omit them
if automatic deployment on successful pushes is required. Protect `main` with
all four CI job names in `ci.yml` and require reviews for deployment-code changes.
No application secrets or database passwords are GitHub Actions inputs.

Do not commit/push until the owner authorizes it. Once these reviewed changes
are on `main`, CI runs for the push. `deploy.yml` listens for successful completion
of the **whole CI workflow**, verifies each required job passed, rejects PR/fork
runs, and deploys the CI run's exact SHA. Superseded commits are skipped. No
privileged deployment artifacts are taken from pull requests.

## Routing and TLS

Keep existing valid certificates and HTTPS server blocks. After auditing them,
only the confirmed customer's existing location needs to proxy to
`http://127.0.0.1:3000`. Keep its normal proxy headers (`Host`,
`X-Real-IP`, `X-Forwarded-For`, `X-Forwarded-Proto`) and existing security settings.
The API uses its independently confirmed route/upstream, with `/health` reaching
the NestJS service. Do not silently expose admin or invent another domain.

Before any separately reviewed Nginx change, back up the exact relevant config
privately, run `sudo nginx -t`, and only then `sudo systemctl reload nginx`.
Preserve certificate renewal configuration and other virtual hosts. No Nginx
configuration is overwritten by the pipeline.

| Service            | Binding                                         | Public route                                                  |
| ------------------ | ----------------------------------------------- | ------------------------------------------------------------- |
| Customer Next.js   | `127.0.0.1:3000`                                | `https://voice.truevinecloud.online/`                         |
| Admin Next.js      | `127.0.0.1:3002`                                | Unconfirmed; internal unless an established route is verified |
| NestJS API         | `127.0.0.1:<apiPort>` (default 3001)            | Existing route to be confirmed; `GET /health`                 |
| NestJS worker      | No HTTP port                                    | None; PM2 stability plus API Redis health are verified        |
| PostgreSQL / Redis | Existing private/loopback endpoints from `.env` | None                                                          |

## Routine deployment and failures

A source archive of the CI-tested SHA is transferred using pinned host keys,
then built on Ubuntu in `incoming`. Builds complete before PM2 activation. The
pipeline uses the actual root build script, checks all four build outputs, links
`.env`, and starts/reloads the explicit ecosystem. `APP_VERSION` reports the SHA.
It verifies local web/admin/API, public web/API, any confirmed public admin,
and PM2 uptime/cwd/version for all four processes. `current` switches atomically
only after those checks pass, then PM2 state is saved. Both workflow concurrency
and server-side `flock` serialize activation and rollback.

PM2 fork-mode reloads can briefly restart each process; this is not a zero-downtime
blue/green deployment. Compilation does not interrupt the active release. A
failed build leaves live processes untouched. Activation/check/save failure
restores and verifies the previous release and still fails the job. If recovery
also fails, the job explicitly fails and needs an operator. Interruption such as
a lost SSH connection/power failure requires inspecting `pm2 ls`, `current`, and
public health before retrying; no system can run an in-process rollback after
being killed. The retained releases and lock support supervised recovery.

There are no models or SQL migrations. Deploy never runs migrate/reset/db push
or Compose teardown. It refuses schema models or non-placeholder migrations
until reviewed expand/contract SQL and a controlled migration procedure exist.

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
