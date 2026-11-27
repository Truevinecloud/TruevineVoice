# W6-01C held-reservation and financial reconciliation assessment

Date: 2026-11-25

**Status: assessment only. No reservation was released, no ledger entry was changed and no reconciliation policy was invented.**

## Observed isolated state

The accepted W6-01B QA evidence contains one `HELD` dispatch reservation of `1000` synthetic UGX minor units for Org A. It is a coordination row, not a wallet entry or financial event. Org A wallet remained `20000` UGX and Org C remained `500` UGX. There was one fake-provider invocation (`fake-1`), one `DIALING` call attempt and one `QUEUED` low-balance attempt.

## Authoritative code paths

- `apps/worker/src/reliability/dispatch-guard.service.ts` is the pre-provider guard. It rechecks campaign state under a shared advisory lock before reserving or invoking a provider.
- `apps/worker/src/reliability/dispatch-reservation.ts` permits:
  - `HELD → SETTLED` only from trusted `COMPLETED` usage settlement.
  - `HELD → RELEASED` only when provider invocation did not start.
- `apps/worker/src/usage-settlement/usage-settlement.ts` consumes the held reservation using exact integer minor units and append-only wallet ledger entries.
- No TTL, heartbeat, sweeper, stale-`HELD` rule, timeout release, emergency-stop release or cancel release exists.
- Duplicate callback protection uses deterministic dedupe keys, receipt uniqueness, locked receipts, locked call attempts, terminal-state guards, quote/usage-event uniqueness, settlement locking and single-debit tests.

## Assessment

A reservation must **not** be released merely because a job timed out or a callback has not arrived. A timeout is not authoritative evidence that the provider did not start or complete a paid call. Releasing on timeout could expose value for a call that later settles, creating an unbacked debit. The `1000` synthetic UGX reservation is therefore correctly protected in the isolated evidence.

## Unresolved cases requiring an approved policy

- Terminal non-billable callbacks after a reservation is held.
- `NO_QUOTE`, `INSUFFICIENT_FUNDS` and `UNKNOWN` outcomes where provider truth is uncertain.
- Crash-after-provider-invocation before the call attempt is durably recorded.
- Stale `HELD` rows after worker loss or queue flush.
- Any rule that converts a held row into a release or a compensating ledger entry.

These cannot be resolved with an invented timeout or a free-form operator adjustment. They require a written owner/accounting decision, an idempotent audited reconciliation procedure, tests for concurrent callbacks and replays, and a migration only if schema support is genuinely required.

## Conclusion

No reservation, wallet entry, ledger entry, campaign state or audit was changed in W6-01C. The held row remains protected until authoritative usage settlement or an approved reconciliation procedure resolves it.
