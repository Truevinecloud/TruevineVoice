# W3-03 Campaign Builder — progress

**Status: implemented locally; PR/hosted CI pending.** Branch:
`feat/w3-03-campaign-builder`, based on current main `faf32347997c5eb3925362823b399c4e657b85a5`.

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
guard; CI requires those runtime checks on Linux.

Focused campaign service/store tests passed (32); full API unit suite passed
(683), full web suite passed (222, including Campaign Builder UI), and migration
manifest parity plus `git diff --check` passed. PostgreSQL E2E was attempted but
could not connect to the configured local database; it failed during fixture
cleanup before assertions ran. No local E2E assertion is claimed. Hosted
The first hosted PR run passed lint/typecheck/Prisma, production build and unit
tests, but failed two PostgreSQL-backed E2E jobs. One new preflight fixture
expected HTTP 200 from the existing consent-creation endpoint, which returns 201. Shared sensitive-audit cases also edited ACTIVE fixture campaigns; the
builder now correctly rejects edits outside DRAFT. Corrected the endpoint
expectation and adjusted those E2E cases to preserve and assert the draft-only
rule and truthful audit behavior. A second hosted E2E run then exposed existing
expectations in campaign emergency-stop/audit cases that assumed status edits
or ACTIVE fixture state. Updated assertions to expect validation rejection of
attempted customer reactivation and to verify rollback leaves the deliberately
DRAFT audit fixtures unchanged. These are test corrections only; the draft-only
builder rule is unchanged. The next full E2E pass surfaced the security-test
runner's explicit migration review guard, which required adding the W3-03
migration to its ordered disposable-database rehearsal list. That reviewed list
is now updated, and hosted CI is being rerun. PostgreSQL E2E, review, merge and
exact-main CI remain pending.

## Deferred and separate acceptance tracking

- No outbound calls, recipient snapshots, scheduler, queue jobs, paid services,
  provider credentials or audio activation are included.
- Workplan v4 was not found in the repository or connected Drive/Excel session;
  workbook update remains pending.
- W2-02 outstanding live acceptance and W3-01/provider/audio acceptance remain
  in their existing records and are not changed or marked passed here.
- No production deployment has been authorized or attempted.
