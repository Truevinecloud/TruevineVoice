# W5-03C analytics API contract

Status: **API wired; W5-03D frontend integrated; W5-03E browser acceptance passed**.
These endpoints are the read-only HTTP surface over the accepted W5-03 metrics
engine and PostgreSQL read adapter. They contain synthetic evidence only during
W5-03 acceptance. Browser acceptance evidence and the remaining §7
product-decision boundary are recorded in `docs/w5-03e-browser-acceptance.md`.

## Authentication and authorization

Every route below is guarded by `SessionGuard`, `OrganizationGuard`,
`CsrfGuard`, `@RequireAcceptedTerms()` and
`@RequireOrganizationPermission('reporting:read')`.

- The organization is read from the path (`/organizations/:organizationId/...`).
  A query field named `organizationId` is ignored.
- `OWNER`, `ADMIN`, `CAMPAIGN_MANAGER` and `VIEWER` hold `reporting:read` under
  the existing role matrix. `BILLING` does not and receives `403`.
- A caller without membership in the path organization receives `403`, the same
  response as an unknown organization.
- No endpoint mutates campaigns, calls, usage, wallet entries or ledger rows.

## Endpoints

| Method | Path                                                                   | Purpose                                                                                         |
| ------ | ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `GET`  | `/organizations/:organizationId/analytics/summary`                     | Organization totals.                                                                            |
| `GET`  | `/organizations/:organizationId/analytics/campaigns`                   | Per-campaign totals plus organization totals. Includes campaigns with no attempts as zero rows. |
| `GET`  | `/organizations/:organizationId/analytics/campaigns/:campaignId`       | One campaign's metadata and totals.                                                             |
| `GET`  | `/organizations/:organizationId/analytics/calls`                       | Paginated organization call log.                                                                |
| `GET`  | `/organizations/:organizationId/analytics/campaigns/:campaignId/calls` | Paginated campaign call log.                                                                    |
| `GET`  | `/organizations/:organizationId/analytics/calls.csv`                   | Bounded CSV export of the filtered call log.                                                    |

### Shared filter parameters

All endpoints accept:

- `from`, `to`: ISO 8601 instants. They must be supplied together; `from` is
  inclusive, `to` is exclusive, `from < to`, and the range may not exceed 366
  days.
- `campaignIds`: one or more UUIDs, as repeated parameters or comma-separated
  values. At most 100 unique IDs. On campaign-specific routes the path campaign
  ID is authoritative; a `campaignIds` query is merged with it.

The paginated endpoints also accept:

- `page`: integer `>= 1`, default `1`.
- `pageSize`: integer `1..100`, default `50`.

Invalid values return `400` with code `invalid_request` before any database
query runs.

## Response structures

Money is always an object `{ "amountMinor": "1234", "currency": "UGX" }`.
`amountMinor` is an exact integer string, never a JSON number or a float. UGX
has zero minor-unit decimal places.

`statusCounts` contains every call state with a count, including zeros:
`ANSWERED`, `BUSY`, `CANCELLED`, `COMPLETED`, `DIALING`, `FAILED`, `NO_ANSWER`,
`QUEUED`, `RINGING`, `TIMEOUT`.

`answered` is the number of attempts whose **current state** is `ANSWERED` or
`COMPLETED`. It is not a provider-reported answer rate and must not be presented
as one. An answer-rate denominator is not defined by the available specification
and is deliberately not invented here.

### Summary

```json
{
  "organizationId": "11111111-1111-4111-8111-111111111111",
  "totals": {
    "attempts": 5,
    "answered": 2,
    "statusCounts": {
      "ANSWERED": 0,
      "BUSY": 0,
      "CANCELLED": 0,
      "COMPLETED": 2,
      "DIALING": 0,
      "FAILED": 1,
      "NO_ANSWER": 1,
      "QUEUED": 1,
      "RINGING": 0,
      "TIMEOUT": 0
    },
    "spend": { "amountMinor": "1000", "currency": "UGX" }
  },
  "reconciliation": { "status": "RECONCILED", "usageEvents": 2, "ledgerEntries": 3 },
  "filters": {
    "from": null,
    "to": null,
    "campaignIds": []
  }
}
```

### Campaigns

```json
{
  "organizationId": "11111111-1111-4111-8111-111111111111",
  "totals": {
    "attempts": 5,
    "answered": 2,
    "statusCounts": {},
    "spend": { "amountMinor": "1000", "currency": "UGX" }
  },
  "campaigns": [
    {
      "campaignId": "22222222-2222-4222-8222-222222222222",
      "name": "Alpha",
      "status": "ACTIVE",
      "createdAt": "2026-01-01T00:00:00.000Z",
      "attempts": 4,
      "answered": 1,
      "statusCounts": {},
      "spend": { "amountMinor": "1000", "currency": "UGX" }
    },
    {
      "campaignId": "33333333-3333-4333-8333-333333333333",
      "name": "Beta",
      "status": "ACTIVE",
      "createdAt": "2026-01-01T00:00:00.000Z",
      "attempts": 1,
      "answered": 1,
      "statusCounts": {},
      "spend": { "amountMinor": "0", "currency": "UGX" }
    }
  ],
  "reconciliation": { "status": "RECONCILED", "usageEvents": 2, "ledgerEntries": 3 },
  "filters": { "from": null, "to": null, "campaignIds": [] }
}
```

The abbreviated `statusCounts` objects above stand for the full ten-state map
shown in the summary example. The single-campaign response uses the same shape
under `campaign` instead of `campaigns`.

### Call logs

```json
{
  "organizationId": "11111111-1111-4111-8111-111111111111",
  "page": 2,
  "pageSize": 2,
  "total": 5,
  "totalPages": 3,
  "items": [
    {
      "campaignId": "22222222-2222-4222-8222-222222222222",
      "attemptId": "44444444-4444-4444-8444-444444444444",
      "state": "NO_ANSWER",
      "answered": false,
      "spend": { "amountMinor": "0", "currency": "UGX" }
    }
  ],
  "totals": {
    "attempts": 5,
    "answered": 2,
    "statusCounts": {},
    "spend": { "amountMinor": "1000", "currency": "UGX" }
  },
  "reconciliation": { "status": "RECONCILED", "usageEvents": 2, "ledgerEntries": 3 },
  "filters": { "from": null, "to": null, "campaignIds": [] }
}
```

`total` and `totals` describe the full filtered result, not the current page.
`totalPages` is `0` when `total` is `0`. A campaign call-log response adds a
`campaign` metadata object.

## CSV export

`GET /organizations/:organizationId/analytics/calls.csv` accepts the shared
filter parameters but not pagination. It returns:

- `Content-Type: text/csv; charset=utf-8`
- `Content-Disposition: attachment; filename="analytics-calls.csv"`
- `Cache-Control: no-store`

The header is:

```text
organization_id,campaign_id,attempt_id,state,answered,spend_minor,currency,status_answered,status_busy,status_cancelled,status_completed,status_dialing,status_failed,status_no_answer,status_queued,status_ringing,status_timeout
```

One row is emitted per attempt. `spend_minor` is the exact integer minor-unit
string; summing it over all rows reproduces `totals.spend.amountMinor`. Cells
beginning with `=`, `+`, `-` or `@` are prefixed with a literal apostrophe before
CSV quoting, preventing spreadsheet formula injection. Provider costs, payloads
and credentials are never exported.

Exports over 10,000 rows return `413` with code `export_too_large`; narrow the
filters and retry.

## Errors

Errors use the existing structured body:

```json
{ "error": { "code": "invalid_request", "message": "Human-readable detail." } }
```

| Status | Code                                                                                                                                                     | Meaning                                                                           |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `400`  | `invalid_request`                                                                                                                                        | Malformed filter, campaign ID or pagination value.                                |
| `401`  | existing auth codes                                                                                                                                      | No session, revoked/expired session.                                              |
| `403`  | existing auth codes                                                                                                                                      | No membership, terms not accepted, or no `reporting:read`.                        |
| `404`  | `analytics_campaign_not_found`                                                                                                                           | Campaign not visible in the path organization.                                    |
| `409`  | `TENANT_MISMATCH`, `DUPLICATE_RECORD`, `ORPHAN_USAGE_EVENT`, `LEDGER_MISMATCH`, `CURRENCY_MISMATCH`, `UNKNOWN_CALL_STATE`, `analytics_evidence_conflict` | Evidence conflict; the report fails closed rather than returning partial numbers. |
| `413`  | `export_too_large`                                                                                                                                       | CSV row bound exceeded.                                                           |

## Specification boundary

This contract does not claim compliance with specification §7, which was not
available during W5-03C. Dashboard layout, final export-column approval and a
real answer-rate denominator remain open product decisions.
