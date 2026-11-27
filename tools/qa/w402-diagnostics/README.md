# W4-02 diagnostics tool

Run from the repository root:

```powershell
node tools/qa/w402-diagnostics/cli.mjs
node tools/qa/w402-diagnostics/cli.mjs --json
node_modules\.bin\vitest.cmd run tools/qa/w402-diagnostics/diagnostics.test.mjs
```

The tool loads the root `.env` file when present and never prints environment
values. It only connects to loopback Redis, PostgreSQL, and API URLs. The queue
defaults to the queue contract's `campaign-execution` name; set
`CAMPAIGN_EXECUTION_QUEUE_NAME` to inspect another configured queue.

All queue operations are getters. BullMQ metadata updates are disabled with
`skipMetasUpdate`; no enqueue, retry, remove, promote, or execution method is
called. PostgreSQL reconciliation aggregation runs inside a read-only
transaction and groups by organization before returning platform-wide counts.
The report omits job IDs, payloads, destinations, organization IDs, and raw
failure reasons.

The Technical Admin integration check reads the local API service source and
does not call the protected endpoint. That avoids adding a Technical Admin
audit event as a side effect of a diagnostics run.

Worker registration comes from BullMQ's Redis client list. It is not equivalent
to the worker process's internal readiness check. Counts and reconciliation
summaries are diagnostics only: they cannot prove crash recovery, idempotent
attempt uniqueness, or provider invocation counts.
