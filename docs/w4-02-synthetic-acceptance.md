# W4-02 acceptance record

Recorded after the isolated synthetic BullMQ recovery suite passed on 2026-11-23.

- **Synthetic Execution and Recovery: ACCEPTED**
- **Production Campaign Dispatch: DISABLED**
- **Production Integration: PENDING**

## Evidence

- `npm run test:w402:postgres`: 2 files, 4 tests passed.
- `npm run test:w402:recovery`: 1 file, 5 tests passed; all five direct-initiation crash checkpoints reconciled without duplicate provider invocation.
- `npm run test:w402:bullmq`: 1 file, 10 tests passed; five BullMQ crash checkpoints plus expansion, duplicate replay, retry/backoff, persistent failure, concurrency and rate limiting.
- `npm run test:w402:enqueue-smoke`: completed with one registered isolated worker, `{status:"missing"}`, zero call attempts and zero call operations.
- Worker unit tests: 34 passed; queue unit tests: 12 passed; worker and queue typechecks clean.
- Audio deletion migration verified read-only against the main schema; retained append-only usage audit records remain valid.
- Reconciliation migration `20261122150000_durable_call_initiation_reconciliation` remains unapplied on the main `truevine_voice` database and applied only in the isolated W402 database.

## Boundaries

All accepted evidence used synthetic fixtures, fake providers, `NODE_ENV=test`, the local `truevine_w402_integration_test` database and local Redis port `56379`. No real calls, payments, billing operations or deployments were performed. The application module hard-disables campaign initiation; real production dispatch remains disabled.

Chrome diagnostics on the admin technical queue page could not be read because the shared development servers had been terminated by a harness timeout and returned `502 Bad Gateway` at the time of the attempt. This is an environment limitation, not a W4-02 test failure.
