# Deployment audit and verification

Date: 2026-10-13. Audited local HEAD:
`cc4aac371eaca3baa0af7bf8d8c820f6a65a51fe`.
Changes in this task are uncommitted; this is not a deployed revision.

## Applications and commands

Root workspaces: `apps/*`, `packages/*`; lockfile v3. Exact runtime pins:
Node `24.19.0` (`.nvmrc`), npm `11.17.0` (`packageManager`).

| Application          | Build command                                | Normal runtime command                       | Production process                           |
| -------------------- | -------------------------------------------- | -------------------------------------------- | -------------------------------------------- |
| Customer `apps/web`  | `npm run build --workspace @truevine/web`    | `npm run start:web` (Next start, 3000)       | `truevine-web`, Next CLI, loopback 3000      |
| Admin `apps/admin`   | `npm run build --workspace @truevine/admin`  | `npm run start:admin` (Next start, 3002)     | `truevine-admin`, Next CLI, loopback 3002    |
| REST API `apps/api`  | `npm run build --workspace @truevine/api`    | `npm run start:api` (`node dist/main.js`)    | `truevine-api`, loopback configured API port |
| Worker `apps/worker` | `npm run build --workspace @truevine/worker` | `npm run start:worker` (`node dist/main.js`) | `truevine-worker`, no HTTP listener          |

`npm run build` builds shared/database/queue first, then all four apps. Packages
are consumed from `dist`. Prisma generation precedes compilation. Both Next.js
configs are ordinary Node-server deployments (no standalone output or basePath).
Their existing foundation pages and component tests remain unchanged. The API
health service probes PostgreSQL and Redis; the worker runs a Nest application
context and logs Redis readiness, with no business queues or HTTP health route.

The Prisma schema has generator/datasource only, no models and no SQL migrations.
The migration directory contains a README placeholder. Production deployment
must not call migrate deploy/dev, db push or reset in this foundation state.
The local Compose file binds PostgreSQL 55432 and Redis 56379 to loopback, but
its known development credentials are unsuitable for provisioning production.

## Findings before changes

- Existing CI has four independent jobs: quality, unit, infrastructure E2E,
  build. It uses SHA-pinned checkout/setup-node and `npm ci`. Only quality checked
  npm; it now sets/verifies the pinned npm version in every job.
- The old deploy workflow ran immediately on pushes, used `ssh-action@master`,
  did `git reset --hard`, used `npm install`, and omitted customer/admin apps.
  It discovered entry points using find/grep, skipped missing worker output,
  and did not verify health or implement rollback.
- No Nginx files or PM2 ecosystem existed in the repository. Documentation did
  not define an admin public URL or API public route. Customer URL was supplied
  by the task. Routing and TLS cannot safely be changed without the VPS audit.
- Two existing local Truevine Voice keys were tried in batch mode with strict
  host-key checking for read-only root SSH audits. Both were rejected with
  `Permission denied`. No VPS commands actually ran.
- `gh auth status` reports invalid tokens for the configured accounts. GitHub
  secrets, environment settings, remote workflow runs and branch protections
  could not be inspected or configured through this session.
- Public HTTPS request to `https://voice.truevinecloud.online/` returned **404**
  using curl outside the sandbox. TLS verification was not disabled. The deployed
  commit, process definitions, certificate configuration, API route and admin
  exposure remain unknown. No production deployment is claimed.

## Files changed

| Path                                           | Reason                                                                                               |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `.github/workflows/ci.yml`                     | Set/verify pinned npm in all four existing jobs                                                      |
| `.github/workflows/deploy.yml`                 | Gate on successful main-push CI, strict SSH trust, exact revision, isolated builds                   |
| `.github/workflows/README.md`                  | Describe deployment and updated runtime setup                                                        |
| `package.json`                                 | Expose npm setup, deployment checks, deploy/rollback commands; include safety tests in npm test      |
| `.gitattributes`                               | Keep deployment shell scripts in LF format on Windows/Linux                                          |
| `.gitignore`                                   | Ignore server-local releases, configuration, locks and isolated validation workspace                 |
| `eslint.config.mjs`                            | Lint Node deployment modules; scope CommonJS require allowance to PM2 config; ignore validation copy |
| `infrastructure/pm2/ecosystem.config.js`       | Explicit PM2 definitions for all four real apps, loopback bindings                                   |
| `infrastructure/scripts/setup-npm.mjs`         | Verify Node and set/verify exact npm without shell interpolation                                     |
| `infrastructure/scripts/deploy.sh`             | Shared flock entry point for deploy and rollback                                                     |
| `infrastructure/scripts/deploy.mjs`            | Production preflight, isolated build, activation, verification and recovery                          |
| `infrastructure/scripts/verify-deployment.mjs` | Foundation HTTP checks, SHA/dependency checks and stable PM2 validation                              |
| `infrastructure/scripts/deploy.spec.ts`        | Deployment safety and rollback behaviour tests                                                       |
| `infrastructure/vitest.config.mts`             | Infrastructure-free deployment test suite                                                            |
| `docs/runbooks/production-deployment.md`       | Safe setup, routing audit, secret configuration, first cutover and rollback                          |
| `docs/runbooks/deployment-audit.md`            | Findings, changes, command outcomes and remaining blockers                                           |
| `docs/adr/0005-production-deployment.md`       | Cross-cutting release and migration safety decision                                                  |
| `docs/adr/README.md`                           | Index ADR 0005                                                                                       |
| `README.md`                                    | Document production commands and actual deployment scope                                             |

The earlier local app start generated `apps/web/AGENTS.md` and
`apps/admin/AGENTS.md`; these remain untracked and are not deployment edits.
The production build regenerated both tracked `next-env.d.ts` files back to
their original repository content. No foundation page or business code changed.

## Commands executed, in order

Read-only inspection commands were batched; repeats below are grouped with their
outcomes. File writes used PowerShell here-strings and Node fs edits. No commit,
push, Git reset, production database change or Nginx mutation was executed.

1. `git status --short`, `rg --files`, `Get-Content` for README/instructions,
   root/apps package files, `.nvmrc`, `.npmrc`, Compose, workflows, entry points,
   Prisma schema/config/migration README, tests, ADRs and environment loader:
   inspected architecture and existing behaviour. One Windows rg glob failed;
   subsequent direct reads covered those files. One Next CLI guide path was
   incorrect; the actual installed guide was found with rg and read.
2. `git remote -v`, `Get-Command ssh,gh,bash`, `gh auth status`,
   `git rev-parse HEAD`, SSH filename listing: confirmed repo/pins; GitHub
   authentication failed. Private keys and environment contents were not printed.
3. `ssh` read-only audit with BatchMode, ConnectTimeout, StrictHostKeyChecking
   and the existing `truevinevoice_contabo` key: permission denied. Retry with
   `truevine_voice_admin`: permission denied. No remote mutations.
4. Public URL probes via browser tool/Invoke-WebRequest: unsuccessful; escalated
   `curl.exe --fail --show-error --silent --max-time 20 --output NUL --write-out
... https://voice.truevinecloud.online/`: HTTP 404, exit 22.
5. Repository implementation: attempted apply_patch stalled and was terminated
   before any file appeared. Created/edited the listed files using workspace
   PowerShell/Node commands instead. No external configuration overwritten.
6. `npm run lint`: initially failed on preserve-caught-error in new rollback
   handling; fixed by preserving the cause on AggregateError.
7. `npm run test:deployment`: sandbox blocked Vitest child processes; approved
   retry passed **28 tests**. Tests were not skipped or weakened.
8. `npm run ci:setup-npm`: sandbox blocked npm child process; approved retry
   verified pins, with a shell-mode deprecation warning. Replaced Windows shell
   invocation with a direct Node/npm CLI subprocess to remove that warning.
9. Created an ignored `.deployment-validation` source copy. `npm ci` in the root
   was accidentally attempted as well as in the isolated copy: sandbox registry
   access failed (ENOTCACHED). Approved retries found peer-range warnings; root
   install hit a Next.js native DLL locked by the earlier local dev servers,
   and isolated install hit ECONNRESET. Neither was reported as passing.
10. Read-only local process inspection identified the original dev process tree.
    A sandbox CIM query was denied; approved query succeeded. Stopped the exact
    verified PID 25532 tree with `taskkill /PID 25532 /T /F`; app processes stopped,
    with nonzero exit because some child shells had already exited. Unrelated
    Codex processes were not stopped. Retried npm ci after releasing the lock.

11. Retried root `npm ci` after stopping the dev tree: **passed**, installed
    719 packages/audited 735; nine high-severity advisories and existing ESLint
    plugin peer-range warnings. The redundant isolated retry was stopped
    explicitly to reduce disk contention; it is not claimed as a passing install.
12. `node --check` for deployment modules/config: passed. Git Bash syntax
    check was initially blocked by the sandbox; approved retry passed.
    Formatting changed tooling/docs via the installed Prettier API also parsed
    both workflow YAML files. An initial optional YAML-parser probe failed
    because that package was not installed; no dependency was added.
13. Final `npm run ci:setup-npm`: passed, no shell-mode warning.
    `npm run prisma:generate` and `npm run prisma:validate`: passed.
    Prisma advertised an RC major update; no toolchain upgrade was made.
14. `npm run typecheck`: passed across all configured workspaces.
    `npm run lint`: passed after fixing the rollback error's nested cause;
    no rule was suppressed to bypass that error.
15. `npm run infra:ps`: both existing local containers healthy on loopback.
    Bash `-n` on all extracted CI/deploy shell blocks and deploy.sh: passed.
16. `npm test`: passed, **81 tests**, including 28 deployment safety tests.
    `npm run test:e2e`: passed, **13 tests** against the real local stack.
    The worker unit test's Redis-down log exercises a fake failure; the real
    worker infrastructure suite verified Redis-up and passed.
17. `npm run build`: passed, shared/database/queue plus API, worker, customer
    Next.js and admin Next.js. Both Next.js apps built their real static foundation
    pages. `git diff --check`: passed; Git's Windows LF/CRLF notices were reported.

## Verification results

| Check                                      | Result                                                 |
| ------------------------------------------ | ------------------------------------------------------ |
| Exact Node/npm setup                       | Passed: Node 24.19.0, npm 11.17.0                      |
| Reproducible root dependency install       | npm ci passed after local lock/network recovery        |
| Prisma generation and schema validation    | Passed                                                 |
| Lint                                       | Passed                                                 |
| Workspace typecheck                        | Passed                                                 |
| Unit + deployment safety tests             | 81 passed                                              |
| API/worker infrastructure E2E tests        | 13 passed                                              |
| Production builds                          | All four applications and shared packages passed       |
| Workflow YAML parsing and shell syntax     | Passed locally; action SHAs verified upstream          |
| Patch whitespace                           | git diff --check passed                                |
| GitHub-hosted CI / deployment workflow run | Not run from this session; GitHub auth invalid         |
| VPS PM2/Nginx/TLS audit and activation     | Blocked by SSH authentication rejection                |
| Public customer HTTPS                      | HTTP 404; no successful production deployment verified |
| Public admin/API                           | Routes unconfirmed; not checked                        |
| Deployed commit SHA                        | Unknown; no production SHA verified                    |

Status update (2026-10-18, read-only external diagnosis, independent of the
session above): production is deployed at `129dbcc`; public `/` and `/health`
answer 200; `/admin` has no public route and stays loopback-only (no admin
authentication exists); the intended browser API route is `/api/*` on the
customer host, proxied to the web app and not directly to the API, which has no
`/api` prefix. The exact VPS `sudo nginx -T` and `pm2 ls` output still needs to
be recorded; SSH access remained unavailable to the diagnosing session, so the
directives above are not yet captured.

No tests were skipped or weakened, no compiler strictness reduced, and no
forced dependency fix applied. CommonJS require is permitted only for the new
PM2 configuration, which PM2 loads as CommonJS. Captured PM2 inventories are
kept in memory; failures report command/exit status instead of dumping process
environments that may contain secrets. Failures still propagate and fail the job.

## Remaining prerequisites and deferred work

Valid deployment-account SSH access, GitHub authentication/secrets, production
PM2 ownership/baseline, readable existing `.env`, route confirmation, private
infrastructure, exact server runtime and approved publication of these changes
are required. See the production runbook for safe steps. Nginx/TLS changes,
production provisioning, migrations and release pruning are intentionally not
performed without their prerequisites. Product features remain deferred by the
repository rules. No deployed SHA has been verified.

Reference documentation used: [GitHub workflow_run events](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#workflow_run),
[PM2 ecosystem configuration](https://pm2.keymetrics.io/docs/usage/application-declaration/),
and the installed Next.js CLI guide under `node_modules/next/dist/docs`.
