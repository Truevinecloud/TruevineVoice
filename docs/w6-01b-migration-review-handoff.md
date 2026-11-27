# W6-01B migration review handoff

Date: 2026-11-24

**Status: review evidence only. Not production approval.** This handoff preserves the outcome of a read-only review of the W6-01 migration proposal. It does not approve, apply or schedule any migration, does not add an entry to `infrastructure/migrations-reviewed.json`, and does not grant W6-01B acceptance or deployment readiness. No production database, live provider, callback endpoint, infrastructure or migration file was changed.

## Scope and target

- W6-01B is the separate isolated browser acceptance pass for campaign dispatch controls. Its target database is `truevine_w601b_qa` only.
- The W6-01B harness pins that database on loopback port `55434`, Redis on `127.0.0.1:56384`, a `w601b-*` queue and a fake voice adapter (`AT_VOICE_PROVIDER=false`); see `scripts/testing/w601b-isolated-env.mjs` and `scripts/testing/w601b-provision-fixtures.mjs`. Any schema application inside that pass is evidence for that isolated database only.
- Migration reviewed: `packages/database/prisma/migrations/20261124130000_w601_campaign_reliability/migration.sql`.
- Supporting evidence read: ADR 0032, ADR 0011, ADR 0013, ADR 0028, `docs/w6-01-campaign-dispatch-reliability-verification.md`, `infrastructure/migrations-reviewed.json`, `packages/database/prisma/schema.prisma`, and the current migration directory listing.

## Observed migration contents

The statements below are the actual contents of the reviewed SQL, not a proposed substitute:

- One transaction (`BEGIN` line 4, `COMMIT` line 117). No down migration is included.
- `ALTER TABLE "campaigns"` adds `dispatch_state` (default `RUNNING`), `dispatch_epoch` (default `0`), `paused_at`, `cancelled_at` and `dispatch_stop_reason` (lines 6–11).
- An `UPDATE` sets `dispatch_state = 'CANCELLED'`, `dispatch_stop_reason = 'emergency_stop'` and `cancelled_at = emergency_stopped_at` for rows carrying an emergency-stop marker (lines 13–18). No other campaign rows are backfilled.
- Check constraints restrict the dispatch state vocabulary, stop reasons, and `emergency_stopped_at IS NULL OR dispatch_state <> 'RUNNING'` (lines 20–44).
- `campaigns_dispatch_state_idx` is created on `("organization_id", "dispatch_state")` (lines 46–47).
- `enforce_campaign_dispatch_transitions()` and trigger `campaigns_dispatch_transitions_guard` reject a decreasing epoch, a restart from `CANCELLED`, and `RUNNING` on an emergency-stopped campaign (lines 51–72).
- `enforce_campaign_emergency_dispatch_stop()` and trigger `campaigns_emergency_dispatch_stop_guard` set `CANCELLED`, reason `emergency_stop`, `cancelled_at` and `dispatch_epoch + 1` when the emergency marker first becomes non-null (lines 77–92).
- `campaign_dispatch_reservations` is created with tenant-scoped primary key `("organization_id", "id")`, unique `("organization_id", "attempt_id")`, composite foreign key to `call_attempts ("organization_id", "id")`, `amount_minor >= 0`, `currency = 'UGX'`, `state IN ('HELD','RELEASED','SETTLED')` default `HELD`, `policy_version`, and a state index (lines 94–115).

The SQL header calls the change "Additive only". The review observed that the transaction also backfills the new dispatch columns for emergency-stopped rows and replaces two functions/triggers; it does not rewrite wallet or financial history.

## Manifest position

`infrastructure/migrations-reviewed.json` ends at `20261122121200_campaign_call_initiation_operation`. Four migration directories present in the tree are absent from it:

- `20261122150000_durable_call_initiation_reconciliation`
- `20261123110000_audio_usage_campaign_set_null`
- `20261123120000_usage_settlement_w5_01`
- `20261124130000_w601_campaign_reliability`

The manifest comment states that an unreviewed directory blocks a deployable tree and that adding an entry is the human review point. ADR 0011 requires reviewed SQL, compatibility with the deployed application, a rollback and a supervised execution plan before an approved migration is applied by the deployment executor.

## Unresolved owner decisions

| # | Decision area | Observed evidence | Owner decision required |
| --- | --- | --- | --- |
| 1 | Manifest approval | W6-01 migration and three other directories are absent from the manifest. ADR 0011 treats manifest entry as a separate approval action. | Decide which of the four directories, if any, are approved together and in what order, and who authorizes the separate reviewed manifest change. No entry was added here. |
| 2 | Approved reserve policy | SQL requires non-negative `amount_minor`, `currency = 'UGX'` and a non-null `policy_version`. ADR 0032 states that no tariff or reserve policy is approved; the worker fails closed outside explicitly isolated fake mode, where a synthetic 1,000-minor-unit UGX reserve with version `w601-synthetic-fixed` is used. | Approve the exact reserve amount, currency, version and policy source for any non-isolated environment. The synthetic value is not an approved tariff and no amount is invented here. |
| 3 | Reservation and stale `HELD` rules | The table has `HELD`/`RELEASED`/`SETTLED`, a unique attempt key and explicit release/settle transitions in the worker, but no expiry, heartbeat or stale-row recovery rule. The guard subtracts all `HELD` rows from available balance. | Define stale-`HELD` recovery or timeout rules and who may release a row after a crash or uncertain provider outcome. Confirm that reservations remain non-ledger coordination rows. |
| 4 | Trigger and epoch semantics | The transition trigger rejects epoch decrease and restart after cancel; the emergency trigger increments the epoch when the marker is set. Application code also increments the epoch for customer transitions and guard-generated pauses, and stale jobs are compared against the stored epoch. | Confirm that the database triggers and application increments are the intended combined boundary, including their interaction with advisory locks, retries and stale-epoch refusal. |
| 5 | Legacy `COMPLETED` default `RUNNING` | Every existing campaign receives `dispatch_state = 'RUNNING'`; only rows with an emergency marker become `CANCELLED`. `CampaignStatus` includes `COMPLETED`, and the guard refuses any non-`ACTIVE` campaign. | Decide the intended dispatch state and presentation/audit meaning for historical `COMPLETED` rows. No extra backfill was added. |
| 6 | Direct organizations FK | The reservations table has tenant-leading primary key, unique key and index, and a composite FK to `call_attempts`; it has no direct FK to `organizations`, although several other tenant-owned tables do. | Decide whether a direct organizations FK and its delete behaviour are required here, or whether the chained composite key is the accepted tenant-enforcement shape. No schema was changed. |
| 7 | `campaigns_dispatch_state_idx` schema drift | The SQL creates the index on `("organization_id", "dispatch_state")`, while `schema.prisma` declares only `@@index([organizationId])` for `Campaign`. The prior review flagged this as drift. | Decide whether to add a matching Prisma index or change/remove the SQL index in a reviewed change before approval. Neither file was edited here. |
| 8 | Rollback policy | The migration is one transaction with no down migration; it backfills new columns and replaces functions/triggers. ADR 0011 says code rollback does not undo SQL and there is no automatic database rollback. | Approve forward-only retention of the new schema or define a documented compensating cleanup and backfill-reversal policy. No rollback was executed. |
| 9 | Deployment prerequisites | ADR 0011 requires manifest validation, migration before PM2 activation and a rehearsed backup/recovery procedure; ADR 0032 explicitly withholds production approval. | Confirm disposable full-history rehearsal, backup/restore evidence, controlled execution plan, approved cost policy and release operator before any deployment. W6-01B browser evidence does not supply these approvals. |

## Deliberately not done

- No migration was applied, reverted, edited or generated; no database or infrastructure was changed.
- `infrastructure/migrations-reviewed.json`, ADRs, `schema.prisma`, manifests, package scripts and all source files were left untouched.
- No owner decision was made or inferred for any row in the table above.
- No approved tariff, reserve amount or recovery policy was invented; the synthetic reserve is recorded only as isolated-test evidence.
- No production data, live provider, payment provider or public callback was contacted.
- No paired-Chrome browser run, lint, typecheck, test or build was performed as part of this documentation-only handoff.

## Relation to W6-01B acceptance

W6-01B is isolated browser acceptance; this document is migration review evidence handed to that workstream. It records what the proposal contains and what remains for an owner to decide. It does not mark W6-01B passed, does not extend the earlier W6-01 verification record to browser acceptance, and does not convert isolated fake-provider evidence into production approval. Browser checks must remain scoped to `truevine_w601b_qa` with the dedicated W6-01B harness; any unresolved row above remains unresolved unless the owner explicitly decides it in a separate reviewed change.
