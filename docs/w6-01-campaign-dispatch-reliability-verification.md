# W6-01 campaign dispatch reliability — verification evidence

Date: 2026-11-24

This record covers the isolated acceptance for the "No new paid work after stop"
criterion in workplan row W6-01. It preserves the W5-03E analytics stack and uses
only the dedicated W6-01 infrastructure and a fake voice adapter.

## Isolation

- PostgreSQL container `truevine-w601-postgres`, database `truevine_w601_qa`,
  loopback port 55434.
- Redis container `truevine-w601-redis`, loopback port 56382.
- Worker test queues use unique `w601-*` names.
- `npm run test:w601*` derives the database URL from the gitignored root `.env`,
  then sets `NODE_ENV=test` and the loopback Redis URL. Credentials are not
  printed or committed.
- No live provider, payment provider, public callback, production database,
  main/local default stack or W5-03E stack was used or modified.
- The new migration in
  `packages/database/prisma/migrations/20261124130000_w601_campaign_reliability/`
  was applied only to the isolated database. It remains a proposal and is not
  listed in `infrastructure/migrations-reviewed.json`.

## Commands and results

| Command | Result |
| --- | --- |
| `npm.cmd run test:w601` | Passed. 13 worker tests and 3 API tests passed. |
| `npm.cmd run test --workspace @truevine/auth` | Passed: 6 files, 116 tests. |
| `npm.cmd run test --workspace @truevine/worker` | Passed: 11 files, 67 tests. |
| `npm.cmd run test --workspace @truevine/api` | Passed: 64 files passed, 1 skipped; 1144 tests passed, 4 skipped. |
| `npm.cmd run test --workspace @truevine/web` | Passed: 33 files, 421 tests. |
| `npm.cmd run test --workspace @truevine/admin` | Passed: 21 files, 144 tests. |
| `npm.cmd run build` | Passed for every package and app. |
| `npm.cmd run typecheck` | Passed for every workspace. |
| Targeted ESLint on W6-01 files | Passed with no output. |
| `npm.cmd run lint` | Failed on 3 pre-existing errors and 1 pre-existing warning outside W6-01 (details below). |

An early admin unit run hit Vitest fork timeouts while multiple heavy suites were
running concurrently. A serial rerun passed with 21/21 files and 144/144 tests.
The final W6-01 run was captured after all fixes and passed on the first attempt.

## Worker acceptance evidence

The root acceptance emitted one `W601_EVIDENCE` line per scenario. Fake-provider
invocation counts are the proof of whether paid work started.

| Scenario | Observed result |
| --- | --- |
| `paused` | `status: paused`, `fakeProviderInvocations: 0` |
| `cancelled` | `status: cancelled`, `fakeProviderInvocations: 0` |
| `emergency-stop` | `status: cancelled`, `fakeProviderInvocations: 0` |
| `insufficient-balance` | `blockReason: insufficient_balance`, `dispatchState: PAUSED`, `dispatchEpoch: 2`, `fakeProviderInvocations: 0` |
| `concurrent-overspend` | wallet 1500 minor units, reserve 1000; one `initiated` outcome and one `blocked` outcome; `fakeProviderInvocations: 1` total |
| `delayed-stale-job` | stale job `stale_epoch`, fresh job `processed`; `fakeProviderInvocations: 1` |
| `retry-jobs` | `attemptsMade: 3`, `fakeProviderInvocations: 1` |
| `worker-restart` | `replayed: true`, `fakeProviderInvocations: 1` |
| `no-duplicate-resume` | dispatch epoch `1 → 3`, `fakeProviderInvocations: 1` |
| `reconcile-prior-calls` | prior provider call `1`, recovery worker `0` |
| `duplicate-callbacks` | `walletDebits: 1`, `usageEvents: 1`, `settledReservations: 1`, `fakeProviderInvocations: 1` |
| `concurrent-stop-dispatch` | `0` invocations before the stop commit, `1` already-started call after the stop, later job `cancelled` |
| `db-redis-failure` | DB fault before provider `0`; DB fault after provider `1`; Redis unavailable exit code `1` with `0` invocations |

## HTTP lifecycle evidence

| Scenario | Observed result |
| --- | --- |
| `customer-lifecycle` | `pauseAudits: 2`, `resumeAudits: 1`, `cancelAudits: 1`, legacy campaign `persistedStatus: ACTIVE` while dispatch state is terminal |
| `cross-tenant-denial` | `attempts: 3`, `auditOutcome: DENIED`, `dispatchState: RUNNING` unchanged |
| `platform-emergency-stop` | `voiceDispatchStopped: true`, customer resume returns HTTP `409`, `auditOutcome: SUCCESS` |

## Known limitations

- The product specification sections §11 and §31 were not available in the
  repository. Acceptance was derived from workplan row W6-01 and ADR 0013/0032.
- No approved tariff or reserve amount exists. Production fails closed when no
  approved cost policy is configured; the synthetic fixed reserve is used only
  inside the isolated tests. No tariff or financial policy was invented.
- Platform re-enable after emergency stop remains an unimplemented proposal in
  ADR 0032. No emergency marker is cleared and no production migration is
  authorized by this change.
- Paired-Chrome browser acceptance was not performed for W6-01; no browser
  verification is claimed.
- Full repository lint remains red for unrelated pre-existing issues:
  unused `PrismaClient` in
  `apps/api/src/payments/top-up-integration.controller.ts`; `no-console` and
  `no-unsafe-finally` in `scripts/testing/w402-enqueue-smoke.mjs`; and a
  `react-hooks/exhaustive-deps` warning in `apps/admin/src/app/billing/page.tsx`.
  No lint rule was relaxed and no failing test was skipped or weakened to make
  the build green.
- Nothing was committed, pushed, deployed or activated.
