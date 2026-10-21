# RBAC-012 backend tenant-isolation audit

Base reviewed: ace16ae1ffa0c39b1bd92bc884c970479de0c62a.
Feature branch: feat/rbac-012-tenant-isolation. Backend only; stop before merge/deploy.

## Tenant-owned resource and operation inventory

| Models | Reachable operations | Enforcement |
| --- | --- | --- |
| Organization | GET/PATCH /organizations/:organizationId; /me membership discovery | Session + organization permission; path membership; update locks/rechecks; /me constrained by caller user ID |
| Membership | GET /members; PATCH/DELETE /members/:userId; POST /ownership/transfer | Scoped composite key; transactional fresh delegation/owner checks; last-owner DB constraints |
| Invitation | GET/POST /invitations; DELETE /invitations/:id; POST /invitations/accept | Scoped reads/mutations; acceptance requires hashed token, active matching identity and valid scoped invitation; inviter DB trigger |
| Campaign | GET/POST /campaigns; GET/PATCH/DELETE /campaigns/:id; GET /reports/campaign-status | Guarded path; composite query; transaction-time write authorization; response projection; emergency-stop marker |
| BillingProfile | GET/PATCH /billing | Guarded billing permission, scoped primary key; explicit fields only; transactional write authorization |
| WalletEntry | GET /wallet and /wallet/transactions?cursor= | Tenant-filtered aggregate/history and tenant-scoped cursor; immutable DB ledger; no customer credit/debit operation |
| TopUpRequest | GET /billing; POST /wallet/top-ups | Organization/key uniqueness; fresh transactional billing authority; actor membership FK; amount mismatch conflict; pending requests only |
| SecurityAuditEvent | Denial/success writers; platform support organization audit; technical/auditor platform trails | Organization-leading primary key; explicit platform-scope filter for platform trail; append-only triggers; projected metadata |
| Contact | Internal create/update only | E.164 validation, organization/id query; no endpoint or dispatcher |
| CampaignRecipient | Internal add/snapshot only | Composite organization/campaign/contact FKs, immutable snapshot |
| CampaignExecution | Internal call acceptance only | One organization/campaign execution; immutable identity |
| CallAttempt | Internal accept/state transition only | Scoped composite parent/lineage FKs; immutable accepted identity; legal states; explicit terminal predecessor for redial |
| CallOperation | Internal acceptance/replay only | Organization/operation/key primary key; canonical versioned fingerprint; atomic attempt/result; parameter conflict rejection |
| CallEvent | Internal event persistence only | Scoped attempt lookup/FK; append-only evidence; conflicting late events cannot overwrite terminal state |

Paths in the table are under /organizations/:organizationId unless stated.
No customer search or bulk mutation endpoint exists. Unknown extra fields cannot
supply tenant authority: controllers/services project supported fields. Existing
billing cursor pagination verifies the anchor in the selected tenant before
reading a page. Campaign reports derive from scoped campaign records.

Global identity/platform models: User, Session, PasswordResetToken,
TermsAcceptance, PlatformRoleAssignment, IdentityAuditEvent and
PlatformOwnerBootstrap. A user may hold independent memberships in A and B.
Identity operations affect the authenticated person, not an arbitrary
client-supplied user/organization. Provisioning/bootstrap are reviewed operator
scripts; neither is a customer privilege.

Platform endpoints: /platform/operations/{me,organizations,campaigns,health} and
POST /platform/operations/organizations/:organizationId/campaigns/:campaignId/emergency-stop;
 /platform/support/{me,organizations,organizations/:organizationId,
organizations/:organizationId/diagnostics,organizations/:organizationId/audit,
users,users/:userId,users/:userId/audit};
 /platform/technical/{me,overview,providers,queues,logs,audit};
 /platform/audit/{me,overview,organizations,audit}.
These deliberately cross organizations only through the existing platform
permission registry and platform guards. Their selected-organization detail,
diagnostics and audit queries are scoped; cross-organization summaries/search
are explicit platform privileges, not organization-owner privileges. RBAC-002
and RBAC-008 have registry entries but no unrestricted role/refund endpoints.

Worker/background audit: apps/worker imports config, Redis and readiness only.
packages/queue constructs connections but declares no business queue/consumer.
No scheduled task, provider webhook, callback or paid side effect is registered.
The nonexistent ingress is tested as unavailable; HTTP guards refuse RPC context.
Future job/callback tenant context must be derived from verified source plus
durable scoped records, not accepted from the payload. No such integration is
implemented as part of this task.

## Findings and fixes

1. Campaign and billing mutations could reuse an earlier guard decision after
membership revocation, role downgrade or suspension. Fix: organization lock,
fresh membership/active-user checks and permission evaluation in the same
transaction as the write. Actor comes from session, never request body.
2. A guard with missing permission metadata previously passed through. Fix:
fail closed, including non-HTTP platform guard contexts; expand route contract
coverage to campaign and billing controllers.
3. Denial audit failure diagnostics printed attacker-controlled organization
identifiers and raw database errors. Fix: fixed diagnostic, preserving the
403 and append-only audit attempt without diagnostic data exposure.
4. Existing tests did not consolidate the full tenant matrix. Added focused
HTTP/PostgreSQL release-blocker tests and unit regressions; existing RBAC and
call suites continue to run.

No demonstrated cross-tenant SELECT leak was found in existing reachable
customer repositories: campaign, member/invitation, wallet aggregates, cursor
lookups and billing reads already include organization scope. Composite call
foreign keys and snapshot/history triggers are retained without migration.

## Remaining risks and explicit limits

Raw Prisma and raw SQL are privileged infrastructure seams, not authorization
boundaries. The unused legacy OrganizationTenantClient placeholder exposes a raw
client and is not used by application repositories; its historical comments
must not be taken as an isolation guarantee. This audit does not replace scoped
repositories with a speculative generic ORM wrapper or claim database RLS.

Internal call persistence is intentionally not registered in AppModule.
There are no contact/call routes to authorize yet. Signature verification,
durable worker context, provider reconciliation and dispatch authorization must
be reviewed before any future real execution ingress. Missing functionality is
not counted as successful testing of a live provider or queue.

An authorized read already in flight may finish after membership changes.
Writes serialize with organization changes. Denial audits/session activity are
expected metadata mutations; business mutation and foreign payload disclosure
are forbidden. Audit delivery failures remain observable with a fixed message.
Platform role changes are checked afresh per HTTP request; this task does not
add a new platform administration API.

Five pre-existing high-severity development advisories are documented and remain
under review. No remediation, frontend, production operation or migration is
included. Full command/results evidence is recorded in the delivery report.
