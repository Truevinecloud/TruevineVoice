# RBAC-014 SessionGuard denial-audit remediation

Date: 2026-10-22. Base: latest fetched `origin/main`,
`e3714a72f1d847d59bad1ca68adc51c442f6d174` (PR #49 merged).
Branch: `fix/rbac014-session-denial-logging`, isolated worktree at
`.worktrees/rbac014-denial-logging`. Existing development changes were preserved.

## Result and changed files

Prohibited support-context requests still receive 403 before their controller
executes, including when denial audit persistence fails. That failure now emits
the established ERROR event with actor ID, fixed denial reason and server time.
The existing formatter moved unchanged into a common API utility, avoiding an
authentication-to-support-service dependency. No new dependency is required.

- `apps/api/src/auth/session.guard.ts`: use the structured failure reporter.
- `apps/api/src/support-access-audit.ts`: shared existing event formatter.
- `apps/api/src/support/support-access.guard.ts`: import the shared formatter.
- `apps/api/src/support/support-access.service.ts`: import the shared formatter.
- `apps/api/test/support-context-denial.http.spec.ts`: three regression/control
  tests using real HTTP/Nest guards and in-memory stores, without Docker.
- `docs/runbooks/support-access-audit-alerting.md`: exact event contract,
  collection/alert requirements and evidence required for production verification.
- `docs/runbooks/README.md`: link the monitoring runbook.
- `docs/rbac-014-session-denial-remediation.md`: this execution report.

## Commands and outcomes, in execution order

Read-only inspections are grouped; polling calls only resumed running commands.

1. `git status --short`, `git remote -v`, `git fetch origin main`: inspected
   existing work; restricted fetch failed writing `.git/FETCH_HEAD`.
2. Approved `git fetch origin main` and
   `git worktree add .worktrees/rbac014-denial-logging -b fix/rbac014-session-denial-logging origin/main`:
   succeeded, based on `e3714a7`.
3. Read README, AGENTS, existing guards/services/tests, ADRs 0009/0020/0021,
   package scripts and PM2 configuration. `rg` searched test patterns and
   collector/alert references. An initial PowerShell wildcard search was
   corrected to search directories with `-g` patterns.
4. `node --version`: v24.20.0. `npm --version` was blocked by PowerShell's
   npm.ps1 execution policy; `npm.cmd --version` succeeded (11.19.0).
   Both runtimes satisfy repository engine ranges; CI uses repository pins.
5. Restricted `npm.cmd ci --ignore-scripts` stalled during registry access and
   was interrupted. A process-inspection attempt using `Get-CimInstance` was
   denied. Approved `npm.cmd ci` succeeded (736 packages); existing ESLint
   peer-version warnings were reported. No dependency/lockfile changes.
6. A first editing attempt using `python` failed because Python was unavailable;
   no files changed in that attempt. Node file edits and `apply_patch` then
   implemented the change. Prettier formatted the selected changed files.
7. `npm.cmd run prisma:generate`: passed; generated only ignored client output.
8. `npm.cmd run lint`, `npm.cmd run prisma:validate`,
   `npm.cmd run typecheck`: all passed (independent commands launched together).
9. `npm.cmd run test --workspace @truevine/api -- support-context-denial.http.spec.ts`:
   passed, 3 tests.
10. Temporarily restored the original SessionGuard from `git show HEAD:...`
    and ran that same regression command: expected exit 1, two logging tests
    failed because the old code emitted no structured Logger error; control test
    passed. A `finally` block restored the fixed file. No test was weakened.
11. `npm.cmd test`: passed all workspace unit suites, including 393 API tests
    and the three new tests. Deployment Vitest: 222 passed, 3 existing skipped.
    Existing db-verify and backup runtime runners explicitly skipped on Windows
    because they require POSIX/Linux. Static coverage ran. These skips were not
    introduced or changed here.
12. `git diff --check` and
    `git diff --exit-code -- packages/database/prisma package-lock.json`:
    passed; no migration/schema or lockfile edits.
13. `npm.cmd run build`: passed packages, API, worker, web and admin production
    builds. Inspected installed Nest ConsoleLogger: ERROR uses stderr; API
    bootstrap uses the default Nest logger. Inspected Git status/diff for scope.

The focused commit/push/PR creation and hosted CI status are reported in the
pull request and final delivery message. They do not authorize merging or release.

## Remaining concerns and deferred work

No production monitoring backend or host was accessed. The repository confirms
the `truevine-api` process definition, default logger and event emitter, but does
not prove the effective PM2 log path, collector, retention policy, alert rule,
recipient or test delivery. The monitoring runbook specifies these requirements
and clearly marks their production verification outstanding. Its alert timing
is a proposed operational requirement, not evidence of an installed alert.

No local database E2E was run; the change is covered by database-free HTTP tests
in the unit command. Hosted CI must verify the submitted head on Linux, including
its existing disposable PostgreSQL E2E and backup/recovery checks.

Production migration approval, lock-window review and recoverable-backup evidence
remain separate release prerequisites from the independent review. No migration,
production data change, deployment, restart, monitoring installation or unrelated
feature was performed. This change does not resolve those operational gates.
