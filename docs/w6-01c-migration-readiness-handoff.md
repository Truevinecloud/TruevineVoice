# W6-01C migration readiness and database-owner handoff

Date: 2026-11-25

**Status: isolated evidence only. `infrastructure/migrations-reviewed.json` was not changed and no production migration was applied.**

## Isolated evidence

A dedicated W6-01C PostgreSQL database `truevine_w601c_qa` was created on loopback `127.0.0.1:55435`, with Redis on `127.0.0.1:56385` and a fake provider (`AT_VOICE_PROVIDER=false`). W5-03E and W6-01 stacks were not stopped, reused or restarted. The W6-01B browser stack was left untouched.

W6-01C-only harness scripts were added under `scripts/testing/w601c-*.mjs`. They pin every child to the dedicated database, Redis port, API port `3301`, queue and fake provider, and refuse other destinations. `prisma migrate deploy` applied the 31 migrations to the isolated W6-01C database only.

## Readiness findings

The W6-01 SQL in `packages/database/prisma/migrations/20261124130000_w601_campaign_reliability/migration.sql` is internally ordered and atomic, but the deployment gate remains blocked:

1. Four migration directories, including the W6-01 migration, remain absent from `infrastructure/migrations-reviewed.json`.
2. `20261123110000_audio_usage_campaign_set_null` has no explicit transaction.
3. The emergency-stop trigger overwrites a same-statement epoch with `OLD + 1`.
4. `campaigns_dispatch_state_idx` shows schema drift against the intended index definition.
5. Reservation constraint/index names show drift.
6. There is no direct organizations foreign key for the new tenant-owned rows.
7. A zero-value reserve is permitted.
8. Backup/restore evidence is stale and was produced against empty data.
9. No full-history W6-01 rehearsal or rollback policy exists.

## Owner decisions required

- Add the four migration directories to the reviewed manifest only after review is complete.
- Decide whether to wrap the audio-usage migration in an explicit transaction.
- Confirm the trigger epoch semantics when multiple updates occur in one statement.
- Resolve index/constraint naming drift and the missing organizations FK with an expand/contract migration.
- Decide whether zero-value reserves should be rejected.
- Produce non-empty backup/restore evidence and a rehearsed rollback policy.
- Authorize deployment explicitly in a controlled environment.

No decision above was silently made in W6-01C. The manifest remains deliberately unchanged.
