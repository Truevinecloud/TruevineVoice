# Support-access denial audit failure monitoring

Status: production collection and alert delivery are **not verified** by this
change. Repository inspection confirms the application emitter and PM2 process
definition only; it does not establish a running collector, retention policy,
alert rule, recipient, or delivery test on the VPS.

## Event contract

When denial audit persistence fails, the API still denies the request and emits
an ERROR through Nest's `SupportAccess` logger. If that logger throws, the same
JSON payload is written to stderr. The payload has exactly these fields:

```json
{
  "event": "support_access_denial_audit_failed",
  "actorUserId": "operator-uuid",
  "reasonCode": "support_context_route_not_allowed",
  "occurredAt": "2026-10-22T12:00:00.000Z"
}
```

`occurredAt` is the server's UTC ISO timestamp. Other support service/guard denial
reasons use this same event name. Never attach the support token, auth cookie,
Authorization header, request body/query, email, tenant content, or underlying
database exception. Actor UUIDs remain restricted operational data.

## Required production collection

1. Collect the `truevine-api` PM2 error stream under the actual deployment user's
   PM2 home. `infrastructure/pm2/ecosystem.apps.js` enables PM2 timestamps but
   does not set a custom error-file path. Determine the effective `pm_err_log_path`
   from a private PM2 inspection; do not assume root's PM2 home or publish a full
   PM2 environment dump. Include rotated files and preserve collection offsets
   through rotation/restarts. If streams are merged by the runtime, collect the
   merged stream too.
2. Parse the JSON message inside Nest/PM2 timestamp, context and possible ANSI
   prefixes. Also accept a bare JSON stderr fallback. Match the payload's `event`
   exactly; do not depend exclusively on a formatted `ERROR` prefix because the
   fallback does not carry it. Preserve `actorUserId`, `reasonCode`, `occurredAt`
   and collector receipt time. Add trusted service, production environment,
   host/instance and release identifiers at collection time.
3. Use authenticated encrypted transport and access-controlled durable storage.
   Document the approved retention duration, rotation capacity, deletion policy
   and responsible operator before enabling production monitoring. No retention
   duration is established by this change. Exclude sensitive headers and request
   payloads in proxy, collector and alert templates as well as application logs.
4. Monitor collector health, ingestion delay, parse failures and dropped events.
   Application output alone is not evidence of durable delivery or alerting.

## Required alert and response

- Evaluate at least every minute. Trigger when at least one production API event
  with `event = support_access_denial_audit_failed` arrives in a rolling five-minute
  window, across **all** reason codes. A single failure warrants investigation
  because a denied security action has lost its database audit record.
- Route to the named production security/operations on-call. Group repeated
  events by service/environment/reason in five-minute windows while retaining
  counts and restricted access to actor identifiers. Do not use actor IDs as
  unbounded metric labels. Escalate an unacknowledged incident after 15 minutes
  through the operator's approved escalation route; recipients and route must be
  recorded and delivery tested, not assumed.
- Include event name, reason, first/last server time, count, affected service and
  release, and a restricted log-search link. Keep actor identifiers in the
  restricted log store rather than broadcasting them in notification text.
- Investigate audit-store connectivity, permissions, database capacity and recent
  release changes. Confirm requests remain denied; never disable the guard or
  grant access to restore audit availability. Do not fabricate missing audit
  history or replay customer mutations.

## Evidence required before claiming monitoring is configured

Record collector identity/configuration version, effective PM2 source path,
restricted destination, retention approval, alert query/window, named on-call
and escalation route, and the timestamp of an acknowledged test notification.
Exercise the emitter, both prefixed and bare JSON parsing, rotation, and the
audit-failure HTTP denial in an isolated environment. Production delivery testing
must use the monitoring system's approved synthetic test facility, clearly
labelled synthetic; do not break production audit persistence or submit customer
mutations to generate an event. Verify a subsequent healthy ingestion check.

No production host or monitoring backend was accessed for this remediation.
