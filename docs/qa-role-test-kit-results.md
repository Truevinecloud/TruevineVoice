# QA Role Test Kit local results — 2026-10-23

## Integration validation — stopped before provisioning

Requested real PostgreSQL/activation/login validation could not begin because isolated infrastructure is unavailable to this session. No database connection, bootstrap, migration, provisioning, password reset, credential generation or login attempt was performed. No production resources were accessed. The eleven proposed isolated usernames remain unprovisioned by this session; the existing `admin@truevoice.com` account and its unknown credential state remain untouched.

Read-only commands, in order:

1. `Get-Location`, `git status --short --branch`, `git rev-parse HEAD`: confirmed the QA worktree, `feat/qa-role-test-kit`, base `0480655`, and preserved existing modified/untracked files.
2. `rg --files` for Compose/UAT/staging/instructions; `Get-Command docker,podman,wsl`; `Get-Content` for Compose files, staging runbook and provisioner: only the development Compose file exists in this worktree. UAT/staging Compose and VPS runbook reads failed because those paths are absent here. Docker/Podman commands were not found; WSL executable exists.
3. Read the main checkout's existing `docker-compose.uat.yml`, `docker-compose.staging.yml` and VPS staging/UAT runbook, omitting potentially sensitive-setting lines from output. No files in that checkout were changed. UAT configuration uses externally supplied database/user/password settings, loopback ports 55433/56380 by default, project-scoped volumes with no fixed resource names, and no external volume declarations. Staging configuration uses separate staging volumes and internal networks. These are configuration intentions, not verified live resource isolation. The VPS runbook describes prepared infrastructure and unresolved preflight requirements; it is not evidence that a usable UAT deployment exists.
4. `Test-Path` for the conventional Docker Desktop CLI location: false. `wsl.exe --list --quiet`: failed with `Wsl/EnumerateDistros/Service/E_ACCESSDENIED`. Stopped per the user's explicit unavailable/unsafe-infrastructure instruction. No installation, alternate remote connection or service startup was attempted.

Isolation verdict: **not verified**. Cannot inspect a Docker daemon/context, resolved UAT target, live volume mounts, PostgreSQL roles/grants, or `pg_hba.conf`. Cannot establish that effective authentication settings or credentials are distinct from production. The general development Compose file is unsuitable for this validation: it has fixed shared resource names and its database name fails the kit allowlist. The kit requires a dedicated loopback `truevine_bootstrap_test_<16 lowercase hex>` database, explicit test opt-in, loopback HTTPS origin and existing test-only singleton Platform Owner bootstrap claim.

Files changed in this validation: this report only. Tests/lint/typecheck/build were not rerun because no implementation changed and integration execution was stopped at infrastructure preflight. Earlier local pass results remain historical results, not integration evidence. Real provisioning, idempotency/concurrency, conflict rejection, activation/password setup, successful/incorrect-password login and HTTP/browser RBAC remain pending. No accounts are ready for login as a result of this validation. No GitHub Actions, push, merge or deployment was used.

Manual login instructions remain in `docs/runbooks/qa-role-test-kit.md`: after verified isolated infrastructure and provisioning, privately activate each identity at the configured loopback HTTPS `/set-password` origin, choose its password, then use that same origin's `/sign-in`. No live UAT URL, password or activation link is confirmed by this session. Do not attempt these proposed identities against production. The generated inventory is in `docs/qa-role-permission-matrix.md`.

## Recovered-workspace continuation

Confirmed the existing worktree at `C:\Users\User\Desktop\TruevineVoice\.worktrees\qa-owner-recovery`, branch `feat/qa-role-test-kit`, HEAD `0480655172b610301f97592ca26ec2c1fb59b914`. All pre-existing changes were retained. Inspection found the untracked provisioner already contained the isolated-target checks, transaction/lock, immutable test-owner prerequisite, secure activation artifacts, auditing, idempotent reruns and assignment-conflict refusal. Its implementation was preserved.

This continuation changed `infrastructure/scripts/qa-role-test-kit.spec.ts`, `apps/api/test/auth.service.spec.ts`, `docs/runbooks/qa-role-test-kit.md` and this results file. The matrix was regenerated without a content change. Added five provisioning cases for preserved QA Owner identity, revoked owner, additional membership, platform authority on a customer identity and inactive identity; also verified each activation token matches its stored hash without printing either. Added eleven incorrect-password rejection cases. The runbook explicitly distinguishes the preserved existing Owner from the independent isolated OWNER stand-in.

Commands in this continuation, in order:

1. `Get-Location`, `git status --short --branch`, `git worktree list`, `git rev-parse HEAD`, and `Get-Content` for the provisioner, README and AGENTS: succeeded and confirmed the recovered state.
2. Targeted `Get-Content` reads of provisioning tests, matrix generator, ADR 0014, permission registry, auth tests and runbook, plus `rg` on package scripts: succeeded. Large combined output was truncated; previously inspected source context remains applicable.
3. Applied the test/runbook changes listed above, preserving the provisioner.
4. `npm.cmd run qa:matrix`: passed, regenerated all eleven roles and the complete matrix after package builds.
5. `npm.cmd run test:qa-role-kit`: **17 passed**.
6. `npm.cmd run lint`: **passed**.
7. `npm.cmd test`: **passed**. API **617 passed**; infrastructure **253 passed, three existing skips**. Other workspace counts are unchanged from the earlier run below. Existing POSIX db-verify and backup runtime checks still explicitly skip on Windows; no tests were skipped or weakened by this continuation.
8. `npm.cmd run typecheck`: **passed** across all configured workspaces.
9. `git diff --check`, `git diff --numstat`, `Get-Command docker -ErrorAction SilentlyContinue`, `node --version`, `npm.cmd --version`, `.nvmrc` and generated inventory reads: no whitespace errors; Docker remains unavailable. Node 24.20.0 and npm 11.19.0 satisfy engine ranges but differ from exact documented pins 24.19.0 and 11.17.0.
10. `npm.cmd run build`: **passed**, including all packages, API, worker, customer web and admin builds.
11. Final `git diff --check` and `git status --short --branch`: no whitespace errors; only the intended existing QA kit changes remain.

No production connection or account inspection occurred. The fake preservation test seeds an independent synthetic `admin@truevoice.com` record, verifies it remains unchanged, and verifies the provisioner never looks it up or issues it a reset token. No actual credentials were generated or delivered. The missing PostgreSQL/Linux/browser rehearsals and missing product surfaces described below remain limitations. No GitHub Actions, commits, pushes, merges, PRs or deployments were used.

Reviewable implementation on `feat/qa-role-test-kit` at `.worktrees/qa-owner-recovery`, base `0480655`. No commit, push, PR, deployment, production database connection, account provisioning or credential rotation was performed. No real activation credentials were issued. The historical production snapshot supplied in the task was not queried again.

## Files created or changed

- `README.md`: root command/runbook links.
- `package.json`: matrix generation, provisioning and focused-test entry points.
- `packages/auth/src/audit.ts`: explicit QA provisioning audit action.
- `apps/api/test/auth.service.spec.ts`: eleven inventory login identifiers tested through AuthService; authentication itself is role-independent. These are fake-backed service logins, not browser logins of provisioned accounts.
- `apps/api/test/authorization.guard.spec.ts`: all 105 organization and 78 platform role/permission cells exercised through the actual guards. Expected grants come from the registry; the pre-existing independent exact-role tests remain the grant-policy oracle. These checks do not replace HTTP endpoint tests.
- `infrastructure/scripts/qa-role-test-kit.mjs`: opt-in isolated target checks, connected database check, advisory lock and serializable transaction, existing singleton-owner prerequisite, creation and unchanged-account verification, shared activation contract, private durable artifact writer and audit entries.
- `infrastructure/scripts/qa-role-test-kit.spec.ts`: twelve fake-backed safety, uniqueness, create/rerun and mismatch tests.
- `infrastructure/scripts/qa-role-matrix.mjs`: generated current registry matrix and controller references.
- `docs/qa-role-permission-matrix.md`: eleven-account inventory, complete grant/deny matrix, missing consumers and dashboard limits.
- `docs/runbooks/qa-role-test-kit.md`: test-only setup, secure delivery, reconciliation and manual checks.
- `docs/qa-role-test-kit-results.md`: this report.

## Commands executed and outcomes, in order

Read-only inspection commands are grouped below in their execution order; no environment files or credential contents were printed.

1. `Get-Location`, `Test-Path .`, `git status --short --branch`, `git worktree list`, `git branch --show-current`, `Get-Content README.md`, `Get-Content AGENTS.md`: succeeded. Root checkout is `C:\Users\User\Desktop\TruevineVoice`, on `feat/rbac-004-customer-billing`, with extensive existing modified/untracked work. Preserved it all. Worktree inventory includes the existing QA worktree and multiple other branches; none removed or reset.
2. In `.worktrees/qa-owner-recovery`: `git status --short --branch`, package scripts, `rg --files` for QA/activation/permissions/roles/instructions, ADR index: succeeded; clean `feat/qa-role-test-kit`, tracking `origin/main` locally. No fetch was performed.
3. `Get-Content`/`Select-String` reads of permission registry/tests, existing UAT provisioning, recovery and bootstrap implementation/tests, Prisma identity/tenancy/token models, guard/auth tests, ADR 0014/0021, Vitest/ESLint configs and controller decorator searches: succeeded. Some large inspection output was truncated; targeted follow-up reads supplied needed sections.
4. Runtime checks: `Test-Path node_modules` true; `node --version` returned 24.20.0; `npm --version` failed because PowerShell blocks npm.ps1. Subsequent developer commands used `npm.cmd` successfully. The repository exact Node pin is 24.19.0; installed Node satisfies engines but exact-pin verification was not achieved.
5. Additional targeted source reads, Git diff/stat checks and PowerShell file writes: succeeded. Edits used apply_patch and targeted PowerShell writes. A temporary whole-file JSON formatting change was replaced with the original package text plus only the three intended script additions; no Git reset/checkout was used.
6. `npm.cmd run qa:matrix`: passed, including all seven package builds and generated inventory/matrix.
7. Further source/schema/test/bootstrap reads and `git diff --stat`: passed. Added the audit vocabulary, runbook and expanded API tests after inspection.
8. `npm.cmd run test:qa-role-kit`: passed, initially ten tests.
9. `npm.cmd run lint`: passed, no errors or warnings.
10. `npm.cmd run typecheck`: passed for every configured workspace, including package builds.
11. `npm.cmd run test:qa-role-kit`: passed, twelve tests after adding provisioning/rerun/mismatch coverage.
12. `npm.cmd test`: passed. Workspace test counts: admin 43; API 606; web 141; worker 5; auth 111; database 5; domain 58; messaging 21; queue 8; shared 19; telephony 18. Infrastructure Vitest: 248 passed, three pre-existing platform-dependent skips. Existing db-verify and backup runners explicitly skipped POSIX/Linux runtime checks on Windows. No skips were added or altered. Expected failure-path test diagnostics included unavailable audit/Redis messages.
13. `npm.cmd run build`: passed: packages, Nest API, Nest worker, Next customer web and Next admin. Frontend route output corroborated the documented surface inventory.
14. `git diff --check`, `git status --short`, route inventory `rg`, private artifact helper/deployment skip reads: succeeded. One exploratory read for a nonexistent platform billing controller returned no contents; the controller inventory confirms no such implementation. Git warns package.json LF will normalize to CRLF; no whitespace errors found.
15. `docker version --format '{{.Server.Version}}'`: failed because Docker is not installed/available on PATH. No database or container was started.
16. `npm.cmd run qa:matrix`: passed again after refining dashboard limitations from actual page paths.
17. Final provisioner review added audit-vocabulary assertion and removed unnecessary artifact bookkeeping. `npm.cmd run test:qa-role-kit`: twelve passed. `npm.cmd run lint`: passed again. Full typecheck/test/build above preceded this small JavaScript-only cleanup; focused tests and lint cover the final provisioner.
18. Final `git diff --check` and `git status --short --branch`: inspected before handoff; intended changes only in the QA worktree.

## Limitations and deliberately deferred work

No isolated database was supplied or created, and Docker is unavailable. Real PostgreSQL rollback/concurrent-run behavior, migration compatibility, durable private-file behavior and the full activation-to-browser-login journey are **not verified**. The implementation uses PostgreSQL transactions/uniqueness and the existing Linux artifact helper, but fake-based tests cannot prove those runtime contracts. Existing HTTP suites ran through npm test; the new matrix cases exercise guards rather than every endpoint over HTTP. Database E2E suites were not run without the required disposable infrastructure. A Linux/disposable-database rehearsal and the manual per-role checklist remain necessary before declaring the QA kit operational.

Provisioning deliberately requires the existing test-only Platform Owner bootstrap and immutable claim; it does not bypass ADR 0014 or create a second owner bootstrap path. Ten remaining accounts are then created atomically and all eleven identities verified. Activation is issued only for newly created users; reruns do not recover lost/expired artifacts or alter pre-existing credentials. No automatic email delivery, missing permission endpoint, contact dashboard, platform billing dashboard, paid external action, production monitoring, production bootstrap or deployment was added. The provisioner is intentionally limited to dedicated loopback test databases and loopback HTTPS application origins; remote staging is outside this smallest implementation.

The initial root README inspection exposed stale foundation text in the unrelated root checkout. The QA worktree has a newer README, also with historical branch-specific descriptions. Only requested QA links were added; unrelated documentation and uncommitted feature work remain preserved.
