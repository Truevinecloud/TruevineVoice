# PostgreSQL restore verification fix — review draft

Proposed PR title: `fix(infra): count archive table definitions and clean restore volumes`

An archive with 11 public tables and 11 corresponding TABLE DATA entries was
reported as declaring 22 tables. Both restore commands now reuse one validated
archive listing and count only public TABLE definitions. The database query
counts public base tables, excluding views. A genuinely incomplete restore still
fails, and a failed archive listing cannot supply an expected count.

Failure cleanup previously attempted to remove volumes before the containers
that referenced them. Cleanup now removes all owned containers before any owned
volumes, retaining the existing run-label ownership checks and original exit
status. Copy and restore errors return failure explicitly: these functions are
called in conditional contexts where Bash disables implicit `errexit` handling.

Regression coverage executes both `verify-restore` and `verify-volume` against
a Docker stub with 11 definitions, 11 data entries, a table in another schema
and a public view. It covers successful restores, too few restored tables,
restore errors and listing errors (including partial listing output), checking
exit status, removal of rehearsal containers/volumes and backup preservation.
The stub now understands actual inspect/create argument ordering and mount
sources, and rejects removal of attached volumes. Termination coverage waits
until the rehearsal reaches readiness before sending SIGTERM; background Bash
can inherit SIGINT as ignored. The shell suite can also run directly in Git Bash.

## Files in this proposed change

- `infrastructure/scripts/db-verify.sh`
- `infrastructure/scripts/db-verify.runtime.sh`
- `docs/postgresql-restore-verification-review.md`

The pre-existing modification to `infrastructure/migrations-reviewed.json` is
excluded. Its bytes remain unchanged: SHA-256
`8efa74145465a6e8d05b160bc68c6114c856d643b03a1ade1f1e2b574e48800b`.

## Commands and verification

Execution order (independent quality gates ran concurrently):

1. Read `README.md` and `AGENTS.md`; ran `git status --short`. Confirmed the
   approval manifest was the only initial modification.
2. Used `rg`, `Get-Content` and `Get-FileHash` to inspect recovery code, tests,
   root scripts, ADRs and the manifest hash. One initial `rg` search used an
   unsupported Windows wildcard operand; subsequent explicit-path searches
   succeeded. Read ADR 0003 and checked ADR references concerning recovery.
3. Inspected the branch/remotes and local tools with `git branch --show-current`,
   `git remote -v`, `Get-Command` and `Get-ChildItem`. `wsl --list --quiet`
   reported WSL is not installed; located Git Bash at `F:/Git/bin/bash.exe`.
4. Ran the shell runtime suite directly with Git Bash. Its first run passed all
   restore scenarios but failed the termination check after the running test
   file was edited. Re-ran the complete finalized suite separately.
5. Initial `npm run lint`, `npm run typecheck`, `npm test`, `npm run build`
   invocations were blocked by PowerShell's `npm.ps1` execution policy. Used
   `npm.cmd` without changing the policy.
6. `npm.cmd run lint`: passed.
7. `npm.cmd run typecheck`: passed.
8. `npm.cmd test`: passed (595 tests passed, three existing tests skipped).
   The existing Windows wrappers skipped Linux-only database-verification and
   encrypted-backup runtime suites; the restore suite was run directly below.
9. `npm.cmd run build`: passed for packages and all four applications.
10. Git Bash `bash -n infrastructure/scripts/db-verify.sh infrastructure/scripts/db-verify.runtime.sh`:
    passed. Complete finalized runtime suite, run with
    `F:/Git/bin/bash.exe infrastructure/scripts/db-verify.runtime.sh infrastructure/scripts/db-verify.sh`:
    passed, including termination after resource creation.
11. `git diff --check`, final `git status --short` and manifest hash verification:
    passed; only the three proposed files and the preserved pre-existing
    manifest modification are present.

## Scope and limitations

No production connection, migration, deployment, merge, commit or push was
performed. No dependencies, developer commands or architectural decisions were
introduced. The proposed PR is prepared locally for review; no remote PR was
opened because this leaves the changes uncommitted and unpublished.

Real Docker/PostgreSQL and encrypted-backup rehearsals were not performed on
this workstation. All restore runtime tests use the Docker stub; they never
contact a Docker daemon or real database. A previously leaked remote volume
was not inspected or removed because production access is expressly excluded.
Financial, tenant, application and migration-approval behavior is unchanged.

## Isolated hosted integration preparation

Prepared locally on 2026-10-19; **not published, dispatched or executed against
real Docker**. The earlier verification above remains the record of the restore
fix itself. This follow-up adds two root commands and a separate optional
workflow; it does not modify `ci.yml`, `deploy.yml` or deployment gates.

Files added or changed in this follow-up:

- `.github/workflows/restore-integration.yml`
- `.github/workflows/README.md`
- `infrastructure/scripts/restore-integration.sh`
- `infrastructure/scripts/run-restore-integration.mjs`
- `infrastructure/scripts/restore-integration.spec.ts`
- `package.json`
- `README.md`
- `docs/postgresql-restore-verification-review.md`

The original `db-verify.sh` and stub-suite fixes are preserved from the earlier
work. The approval manifest retains the SHA-256 recorded above.

The hosted integration harness requires an empty daemon on a GitHub-hosted
Linux runner and forces the runner-local Unix Docker socket. It creates its own
PostgreSQL fixture and exercises the actual, unmodified recovery CLI for both
`verify-restore` and `verify-volume`. Its archives have 11 public TABLE entries
and 11 corresponding TABLE DATA entries, plus a private table and public view.
Both commands must succeed with the complete archive, then fail during real
`pg_restore` with a readable archive that deliberately omits a function schema
required by a default expression. Every case checks that only the source fixture
remains before fallback cleanup; the final assertion requires no containers or
volumes at all. A trap and an unconditional workflow cleanup step check resource
labels and never prune the daemon. No PostgreSQL port is published, no database
URL or production credentials are used, and no migrations run.

Follow-up commands, in execution order (quality checks ran concurrently):

1. `Get-Content`, `rg`, `git status --short`, `Get-FileHash`: inspected repository
   instructions, existing workflow/test conventions, ADR 0004, restore code and
   manifest identity before editing.
2. `npm.cmd run test:restore-integration:checks`: initially four tests passed and
   one failed because an overbroad safety expression matched the fixture table
   `_prisma_migrations` as though it were a Prisma command. Corrected the check
   to detect actual Prisma command invocation. All five tests then passed.
3. Git Bash `bash -n infrastructure/scripts/restore-integration.sh`: passed.
4. Git Bash `bash infrastructure/scripts/db-verify.runtime.sh infrastructure/scripts/db-verify.sh`:
   passed all existing stub regressions, restore scenarios and termination
   cleanup checks.
5. `npm.cmd run lint`: passed.
6. `npm.cmd run typecheck`: passed.
7. `npm.cmd test`: passed (600 tests passed; three existing tests skipped).
   Existing Windows wrappers skipped their Linux shell suites; the restore stub
   suite was separately executed with Git Bash as recorded above.
8. `npm.cmd run build`: passed for packages and all four applications.
9. Formatted only the three new YAML/JavaScript/TypeScript files using the
   installed Prettier API; reran `npm.cmd run test:restore-integration:checks`:
   all five tests passed. YAML parsing and refusal outside a hosted runner are
   covered by these tests.
10. Final Git Bash `bash -n` checks for the integration/restore/stub scripts and
    `git diff --check`: passed. `git diff --name-only -- .github/workflows/ci.yml .github/workflows/deploy.yml`
    returned no changes. `Get-FileHash infrastructure/migrations-reviewed.json`
    matched the original SHA-256; `git status --short` confirmed the intended
    files alongside the preserved earlier work.

Remaining risk: real Docker/PostgreSQL execution still needs a passing run of
the prepared hosted workflow. The workflow has no deployment environment,
production secrets or connection settings. It is separately named so it cannot
satisfy the production workflow's `CI` completion trigger. Docker image pulls
and runner availability can fail the hosted job; missing infrastructure fails
loudly. A forcibly terminated runner ultimately discards its entire disposable
environment, even if its cleanup step cannot execute. No Docker installation,
production access, remote PR publication, push, merge or deployment was attempted.

## Hosted initialization readiness correction

Original publication: `23396ea1a6ad9504adaab10ce53af3fdde81782f`,
[run 39218360186](https://github.com/Truevinecloud/TruevineVoice/actions/runs/39218360186).
All five safety tests and shell regressions passed. Real `verify-restore`
succeeded, counted 11 public tables rather than 22 table/data records, and
asserted container/volume removal. The next `verify-volume` invocation failed
while restoring into **container A**, before removing A or creating B:
`FATAL: database "truevine_voice" does not exist`. The unconditional cleanup
step passed; the planned controlled failures and final empty-daemon assertion
were not reached.

The defect is the target readiness check in `db-verify.sh`, not volume recreation
or archive sequencing. `start_pg` correctly sets `POSTGRES_DB=truevine_voice`,
but `wait_for_pg` used `pg_isready` over the default Unix socket. PostgreSQL
documents that `pg_isready` can return server status without a valid database
name. The official image initializes an empty volume by starting a socket-only
temporary server, creating `POSTGRES_DB`, running initialization scripts, then
stopping it and starting the final server. Thus the old check could pass before
the database existed, or before the temporary server's shutdown.

Sources: [pg_isready notes](https://www.postgresql.org/docs/current/app-pg-isready.html#APP-PG-ISREADY-NOTES)
and [official image startup sequence](https://github.com/docker-library/postgres/blob/master/docker-entrypoint.sh).
The original job did not retain the target container's server logs; the failed
phase, correct environment, documented probe semantics and image startup code
identify the race, rather than providing a timestamped trace of its internals.

Correction: retain the existing bounded retry loop, but require a successful
`SELECT 1` in the target database over `127.0.0.1` inside the disposable
container. TCP excludes the image's socket-only temporary server, and the SQL
query proves the target database exists and accepts queries. It also works for
container B, which skips initialization on the retained volume; there is no
dependence on an initialization-complete log line or an arbitrary fixed sleep.

Regression coverage models `pg_isready` accepting connections while the target
database is absent, followed by a socket-only database and finally a usable TCP
server. Both restore commands must wait through those phases. The volume test
asserts readiness separately for A and B. Restore fails in the fake if either
command proceeds early. Existing failure cleanup and termination tests remain.

Files in this correction:

- `infrastructure/scripts/db-verify.sh`
- `infrastructure/scripts/db-verify.runtime.sh`
- `docs/postgresql-restore-verification-review.md`

Commands and verification for this correction, in execution order:

1. Read repository instructions, recovery scripts/tests and ADRs; checked branch,
   working tree and manifest hash. Retrieved the complete 598-line original run
   using `gh run view 39218360186 --repo Truevinecloud/TruevineVoice --log` and
   inspected readiness, restore and cleanup evidence. Consulted the two primary
   sources above to establish the image's initialization sequence.
2. Added the initializing regression before changing the production helper.
   Git Bash `bash infrastructure/scripts/db-verify.runtime.sh infrastructure/scripts/db-verify.sh`
   failed as expected with four assertions: both commands proceeded too early
   and neither performed target SQL readiness probes. Existing cases passed.
3. Replaced the readiness check and ran Git Bash `bash -n` on both scripts:
   passed. Re-ran the complete shell regression suite: passed, including both
   initializing cases, readiness for A/B and termination cleanup.
4. `npm.cmd run lint`: passed.
5. `npm.cmd run typecheck`: passed.
6. `npm.cmd test`: passed (600 tests passed, three existing skips). The Windows
   wrappers skipped Linux-only shell suites; the restore shell suite runs
   separately through Git Bash, as above.
7. `npm.cmd run build`: passed for packages and all four applications.

No workflow, schema, migration, package command or dependency changes are needed.
The manifest remains excluded and unchanged. Only the existing isolated test
branch is authorized for publication; no PR, merge or deployment is authorized.
