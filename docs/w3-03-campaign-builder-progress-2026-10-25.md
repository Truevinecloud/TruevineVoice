# W3-03 Campaign Builder — progress

**Status: merged and exact-main CI verified.** PR #70 merged as
`717642b7972194d85a2cd5f8bfaa04fda8b67978`. Feature branch:
`feat/w3-03-campaign-builder`, based on main
`faf32347997c5eb3925362823b399c4e657b85a5`.

## Existing functionality audit

- Reused the organization-scoped Campaign model, CRUD, RBAC and audit path.
- Reused campaign audio-asset selection and existing private asset library.
- Reused contact groups and current consent/suppression eligibility filter.
- Existing campaign preparation did not persist an audience or schedule/retry
  policy and had no preflight endpoint or builder UI.

## W3-03 implementation

Implemented: DRAFT-only campaign configuration for audio, contact group IDs,
schedule and bounded retries; tenant foreign keys; read-only preflight; minimal
create/edit/review UI. Preflight is an estimate and does not create recipients,
executions, jobs, calls or provider operations. Schedule is stored only.

Current rules: schedule 5 minutes to 365 days in the future; retry attempts 1–5
(including the first attempt); retry delay 5–1440 minutes. The additive
PostgreSQL migration has retry-bound checks, composite tenant foreign keys, safe
defaults for existing rows, and a single transaction. SQL and manifest parity
were reviewed locally; no migration was applied. Hosted E2E must apply it only
to CI's disposable PostgreSQL instance.

## Verification

Passed locally: Prisma validation/generation, workspace package build, full
workspace typecheck, repository lint, production build, and `npm test` (including
deployment/migration safety tests). The full unit command reported 302 deployment
tests passing with 3 Linux-only backup runtime checks skipped by its Windows
guard; CI required and ran those runtime checks on Linux.

Focused campaign service/store tests passed (32); full API unit suite passed
(683), full web suite passed (222, including Campaign Builder UI), and migration
manifest parity plus `git diff --check` passed. PostgreSQL E2E could not run
against the configured local database, so no local E2E assertion is claimed.

Hosted CI found and corrected test/rehearsal issues: the existing consent endpoint
returns 201, builder edits are draft-only, and the security migration guard
requires each new migration in its ordered review list. Final verification:

- PR checks on feature head `0a9d3c5cf9a06a8c14613a62231b48938fda3cf9`:
  [CI run 40167179444](https://github.com/Truevinecloud/TruevineVoice/actions/runs/40167179444)
  passed lint/typecheck/Prisma validation, unit tests, production build, and full
  PostgreSQL E2E. [Campaign and billing database E2E run
  40167179448](https://github.com/Truevinecloud/TruevineVoice/actions/runs/40167179448)
  and [migration rehearsal run
  40167179489](https://github.com/Truevinecloud/TruevineVoice/actions/runs/40167179489)
  also passed.
- [PR #70](https://github.com/Truevinecloud/TruevineVoice/pull/70) merged as
  `717642b7972194d85a2cd5f8bfaa04fda8b67978`.
- Exact-main CI for the merge SHA passed all four jobs in
  [run 40167931816](https://github.com/Truevinecloud/TruevineVoice/actions/runs/40167931816).
  Main-branch [database E2E run
  40167934635](https://github.com/Truevinecloud/TruevineVoice/actions/runs/40167934635)
  and [migration rehearsal run
  40167934757](https://github.com/Truevinecloud/TruevineVoice/actions/runs/40167934757)
  passed on that same SHA.

## Deferred and separate acceptance tracking

- No outbound calls, recipient snapshots, scheduler, queue jobs, paid services,
  provider credentials or audio activation are included.
- Workplan v4 was not found in the repository or connected Drive/Excel session;
  workbook update remains pending.
- W2-02 outstanding live acceptance and W3-01/provider/audio acceptance remain
  in their existing records and are not changed or marked passed here.
- No production deployment was authorized or attempted. Deployment still
  requires explicit authorization through the protected CI/CD workflow.
