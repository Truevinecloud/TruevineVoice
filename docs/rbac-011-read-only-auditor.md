# RBAC-011: Platform read-only Admin / Auditor

## Existing implementation and changes

ADR 0016 remains authoritative. `AUDITOR` has exactly platform tenant,
operations, support and audit read permissions. The permission registry,
SessionGuard and PlatformGuard already enforce these permissions server-side.
No backend production change, permission expansion, migration or dependency
was needed.

The existing audit controller exposes GET-only operator context, overview,
organization metadata and audit trail routes. Audit reads fail closed if the
read audit cannot be written. The store excludes organization-scoped security
records before pagination; the service allowlists response metadata. Technical
Admin retains its separately restricted audit projection.

This change completes the Auditor pages with visible read-only indicators,
loading and failure recovery, readable UTC timestamps, expandable event and
target details, and responsive styling using existing brand tokens. Pagination
uses the submitted action filter rather than the draft input. Requests are
cancelled on navigation; denied access clears previously loaded data. There are
no business mutation controls in this workspace. Existing Operations controls
already check write permissions, and remain unchanged.

## Automated coverage

- Actual Nest HTTP guards with synthetic sessions: Auditor and Platform Owner
  reads, denied roles, absent sessions, read auditing, and all four write verbs
  against each audit route.
- Every mutation handler in all seven current platform controllers: session,
  CSRF and platform guards, Auditor denial, denial auditing, and the permission
  matrix for every other platform role. Billing and payment configuration are
  now included in this route inventory.
- Existing service/store tests retain metadata projection, platform scope,
  cursor, ordering and fail-closed coverage.
- React DOM tests cover pending loads, 401/403, failure recovery, applied-filter
  pagination, GET-only calls, cancellation and clearing data after revocation.
  Presentation tests verify UTC timestamps, target details and absence of writes.

## Local verification and command record

Inspection preceded editing: `Get-Content README.md`, `Get-Content AGENTS.md`,
`git status --short`, ADR inventory and ADRs 0015/0016, followed by `rg --files`,
`rg`, and `Get-Content` for the permission registry, guards, controllers, audit
service/store, Admin shell/pages, related unit/HTTP/E2E tests, scripts and local
Next.js client-component documentation. The working tree contained unrelated
changes before this task; those are excluded from the commit.

Verification commands, in execution order:

1. `npm run test --workspace @truevine/api -- route-guards.spec.ts`: PowerShell
   refused npm.ps1 under its execution policy. Subsequent commands use npm.cmd;
   no policy was changed.
2. `npm.cmd run test --workspace @truevine/api -- route-guards.spec.ts`: passed,
   35 tests.
3. `npm.cmd run test --workspace @truevine/admin -- auditor`: initial worker
   startup timeout; presentation tests ran, page worker did not start.
4. `npm.cmd run lint`: passed, with an existing exhaustive-deps warning in
   `apps/admin/src/app/billing/page.tsx`.
5. `npm.cmd run typecheck`: passed across the monorepo.
6. `npm.cmd run test --workspace @truevine/admin -- auditor --maxWorkers=1`:
   one new assertion initially used lowercase datetime; corrected to React's
   static markup dateTime attribute. Page tests passed.
7. `npm.cmd run test --workspace @truevine/api -- auditor.http.spec.ts audit.service.spec.ts prisma-auditor.store.spec.ts authorization.guard.spec.ts route-guards.spec.ts billing-admin.http.spec.ts --maxWorkers=1`:
   396 passed; existing billing-admin HTTP first test timed out at 5 seconds.
8. `docker ps --format "{{.Names}} {{.Image}} {{.Ports}}"`: sandbox access denied;
   approved read-only retry succeeded. Only existing development PostgreSQL and
   Redis containers were present. No database connection or write was attempted.
9. `npm.cmd run build`: result recorded below.
10. `npm.cmd test -- --maxWorkers=1`: all workspaces except API passed; API had
    874 passes and the same billing-admin first-test timeout. The root extra
    argument does not constrain workspace workers. Deployment tests were not
    reached in this run.
11. File inspection, `git diff --numstat`, `git diff`, `git diff --check` and
    `Get-Process node` reviewed scope and local runner contention. A Windows rg
    wildcard path failed and was rerun correctly using `-g '*.controller.ts'`.
    An initial Next.js documentation path used .mdx; the local .md was read.
    `npm.cmd run format -- --help` printed help only; it did not format the repo.
    UTF-8 encoding of the two rewritten pages was normalized after Windows
    PowerShell wrote an ellipsis using its default encoding.
12. `npm.cmd run test --workspace @truevine/admin -- auditor --maxWorkers=1`:
    passed, 21 tests, including final page changes.
13. `npm.cmd run test --workspace @truevine/api -- billing-admin.http.spec.ts --maxWorkers=1`:
    passed, all 8 tests, without changing test timeouts or assertions.
14. `npm.cmd test`: final result recorded below.
15. `npm.cmd run lint -- apps/admin/src/app/auditor apps/api/test/auditor.http.spec.ts apps/api/test/route-guards.spec.ts`:
    final result recorded below (root script also includes the repository).

## Safety and deferred verification

Real PostgreSQL audit E2E and authenticated browser QA remain deferred: no
verified disposable QA target was available. The existing development database
and its accounts must remain unchanged. ADR 0016 requires real database merge,
ordering and pagination verification before release; fake-based tests do not
establish those properties. No live browser login was attempted because reads
would write audit records to that database.

No root .env, existing accounts, database records, production/staging systems,
permissions, provider integration or financial behavior was changed. No deploy
or push is part of this task. README setup commands and architectural decisions
are unchanged. The local commit contains only the RBAC-011 UI, regression tests
and this verification record.

Final verification outcomes:

- `npm.cmd run build`: passed for every package and all four applications.
- `npm.cmd test`: passed. Workspace tests: 1,559 passed, including all 875 API
  tests and 113 Admin tests. Deployment static/unit tests: 354 passed and three
  existing POSIX-only cases skipped on Windows. Existing db-verify and backup
  runtime scripts report Windows skips; these were not changed by this task.
- Final focused Auditor UI tests: 21 passed. Billing retry: 8 passed.
- `git diff --check`: passed. Only the ten files listed below belong to this
  implementation. Existing unrelated changes remain outside the commit.

Files created or changed:

- `apps/admin/src/app/auditor/page.tsx`
- `apps/admin/src/app/auditor/organizations/page.tsx`
- `apps/admin/src/app/auditor/audit/page.tsx`
- `apps/admin/src/app/auditor/auditor-ui.tsx`
- `apps/admin/src/app/auditor/auditor-ui.spec.tsx`
- `apps/admin/src/app/auditor/auditor-pages.spec.tsx` (new)
- `apps/admin/src/app/globals.css`
- `apps/api/test/auditor.http.spec.ts` (new)
- `apps/api/test/route-guards.spec.ts`
- `docs/rbac-011-read-only-auditor.md` (new)

Final staging commands and results:

16. `npm.cmd run typecheck` after the final edits: passed again.
17. Final lint rerun: passed, zero errors; the existing Billing hook warning
    remains. No new lint warning was introduced.
18. `git diff --check`, `git diff --cached --check`, `git diff --cached --stat`,
    `git diff --cached --name-only`, `git branch --show-current` and staged diff
    review: passed; exactly the ten RBAC-011 files are staged on the existing
    `feat/rbac-010-technical-admin` branch. No secret or permission expansion was
    introduced. Builds rewrote generated next-env declarations; their local dev
    type references were restored and excluded from staging.
19. Explicit-path `git add -- <the ten files above>`: the sandbox initially
    refused the index lock; the approved retry staged only those files.
20. `git add -- docs/rbac-011-read-only-auditor.md` and
    `git commit -m "feat(admin): complete RBAC-011 read-only auditor experience"`:
    local-only staging/commit, followed by `git log -1 --oneline`,
    `git show --stat --oneline HEAD` and `git status --short` verification.

Release limitations remain the isolated PostgreSQL E2E and authenticated browser
QA described above, plus existing Windows-only verification gaps. No migration
or live account action is included in this commit.
