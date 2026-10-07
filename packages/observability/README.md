# @truevine/observability

Reserved for structured logging, metrics, tracing and error reporting.

**Status: intentionally empty.** No logging or tracing vendor has been selected,
so introducing SDK dependencies now would be premature.

At the foundation stage each app uses Nest's built-in `Logger`, which already
emits structured, timestamped output.

When this package is populated it must guarantee:

- Log payloads never contain credentials, tokens, personal data or full phone
  numbers. Redaction is centralised here, not left to call sites.
- Every log line carries the correlation identifier that ties an API request to
  the worker jobs it produced.
- Health probes report failures without leaking connection strings.
