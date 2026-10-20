# 0012 — Customer billing and pending top-up requests

Status: Proposed implementation; not approved for production deployment.

RBAC-004 introduces customer wallet/billing reads and billing-detail updates.
The existing permission registry remains authoritative: OWNER and BILLING can
access billing; ADMIN, CAMPAIGN_MANAGER and VIEWER cannot. Membership is checked
per request; a billing role confers no campaign or contact permissions.

UGX is the initial currency. Amounts are signed integer minor units in PostgreSQL
BIGINT and JavaScript bigint, serialized as decimal strings. No float conversion,
rounding, exchange rate or monetary calculation from JSON numbers is permitted.
Balance is a SUM of append-only wallet entries. Update, delete and truncate are
blocked by database triggers; references are unique within the organization.
Corrections require compensating entries through a future reviewed settlement
path, never history edits. There is no customer endpoint to credit a wallet.

No payment provider has been selected. A top-up records a durable pending request
only: it does not collect payment or credit a balance. The UI states this before
submission. A unique (organization_id, idempotency_key) constraint serializes
concurrent retries, and replay with a different amount returns 409. The browser
keeps an ambiguous request's key in tab session storage across refreshes. Requests
remain pending until a separately reviewed provider confirmation/settlement flow
exists. No mock settlement route, manual production write, or provider SDK is added.

Every financial row carries organization scope in its primary key or identifier,
foreign key, index and query. Pagination anchors are resolved within the requested
organization. Client-supplied tenant/actor fields cannot override authenticated
path/session context. Billing details are metadata, not tax invoices or a charging
engine; neither invoice issuance nor usage charging is claimed complete.

The additive migration remains absent from the approval manifest and blocks
deployment until reviewed. Existing applied migrations and production data remain
unchanged. Database-backed E2E tests must run against disposable test infrastructure
before production approval; fake-store HTTP tests do not substitute for that check.
