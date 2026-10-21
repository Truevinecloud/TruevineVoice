# RBAC-013 sensitive-action assessment and coverage

Baseline: 5b5f1b00f4d18af3d9d890ebf6577d7b47317430.
Branch: feat/rbac-013-sensitive-action-audit.
Status: development and review pending; workplan remains In Progress.
Backend only; no merge, production migration or deployment authorized.

## Existing assessment and identified gaps

The existing security_audit_events and identity_audit_events are retained.
Both have UUID IDs and PostgreSQL-generated occurred_at timestamps. Tenant
events have organization-leading identity and actor FKs; identity events
deliberately belong to people/platform operations, not a fabricated tenant.
Existing actions, outcome types, columns and consumer response envelopes remain.

RBAC-012 provides session/path membership guards, separate platform authority,
composite tenant relations and transaction-time campaign/billing membership
checks. Raw database clients are privileged infrastructure, not authorization
boundaries; no RLS guarantee is claimed.

Gaps found:

1. Organization, permission, account and emergency writes already audit in a
   transaction, but most lack consistent target/before/change/after/reason.
2. Campaign audits occur after mutation commit; billing profile/pending top-up
   writes have no sensitive-action audit.
3. Audit row UPDATE/DELETE guards do not stop TRUNCATE. Wallet/call/bootstrap
   histories already have separate statement guards.
4. Metadata safety checks only inspect top-level keys and exact spellings.
5. Platform denials without organization context are not recorded.
6. Emergency platform authority needs a transaction-time role recheck to fence
   revocation rather than relying only on the HTTP guard.
7. Initial Owner repository provisioning lacks a required audit. Operator grant
   scripts already audit but have incomplete state records.
8. Membership role editing checks the new role's delegation but not the prior
   role. An Admin can demote a peer Admin/Billing member. Apply the existing
   removal/delegation ladder to the prior role too, with regression tests.

## Sensitive-action coverage matrix

New records use auditVersion 1, target {type,id}, before, change, after,
reasonCode, justification, reasonSource and requestId in existing metadata.
Successful tenant mutations also populate existing targetType/targetId columns. Historical
rows are never rewritten. Denials do not read foreign before/after state.

| Supported backend mutation | Existing trail / action | State and purpose | Required audit boundary |
| --- | --- | --- | --- |
| Organization profile | Tenant / organization.profile_updated | Name digest before/after, changed fields | Existing locked organization transaction |
| Membership role | Tenant / organization.member.role_changed | Actual previous/new role, target user, reason | Existing locked organization transaction |
| Membership removal | Tenant / organization.member.removed | Actual old role, removal, after null | Existing organization transaction |
| Ownership transfer | Tenant / organization.ownership.transferred | Old/new Owner IDs and both role changes | Existing organization transaction |
| Invitation issue | Tenant / organization.member.invited | Invitation target and granted role, before null | Existing organization transaction |
| Invitation revoke | Tenant / organization.invitation.revoked | Prior revoked/accepted state, applied revocation | Existing organization transaction |
| Invitation acceptance | Tenant / organization.invitation.accepted | Actual membership before/after and invitation ID; no capability | Existing organization transaction |
| Campaign lifecycle/status | Tenant / campaign.created, campaign.updated, campaign.deleted | Scoped prior/applied status, stop marker and name digest | Repository mutation and audit now share one transaction |
| Billing details | Tenant / billing.profile_updated | Presence/digest, changed fields; no copied payer email/address | Repository mutation and audit now share one transaction |
| Pending top-up request | Tenant / billing.top_up_requested | Exact minor-unit text/currency, PENDING; no wallet credit | First accepted insert/audit atomic; identical replay has no duplicate SUCCESS |
| Top-up parameter conflict | Tenant / authorization.denied | Attempted action, no newly accepted request | DENIED audit without false success or wallet mutation |
| Self-deactivation | Identity / auth.account_deactivated | Prior/applied account status, all-session revocation | Existing user transaction |
| Password recovery/activation | Identity / auth.password_reset_completed | Credential-change time, session revocation; no password/hash/capability | Existing user transaction; recovery-capability attribution |
| Session revocation | Identity / auth.session_revoked | Session target, revoked false/true, self-sign-out purpose | Existing transaction |
| Terms acceptance | Identity / terms.accepted | Prior acceptance, accepted version | Existing transaction |
| Automatic lockout | Identity / auth.account_locked | Prior/applied counters and deadline; authentication outcome DENIED | Existing user transaction |
| Initial Owner repository provisioning | Identity / organization.owner.provisioned | OWNER membership and organization, before null | User/organization/membership/audit atomic |
| Local first-Owner tool | Identity / auth.owner_provisioned | Existing operator workflow, local_operator attribution | Existing transaction |
| UAT Operations Admin grant | Identity / platform.operations_admin.provisioned | Role before null/after grant, active PLATFORM_OWNER actor, approval reference | Existing transaction |
| First Platform Owner bootstrap | Identity / platform.owner.bootstrapped | Role grant, existing external-operator/approval references and operation ID | Existing audited singleton transaction |
| Platform emergency stop | Tenant with PLATFORM scope / platform.campaign.emergency_stopped | ACTIVE to COMPLETED/paused marker, mandatory existing reason code | Conditional write/audit atomic; fresh platform authority; replay no duplicate SUCCESS |
| Authorization denial | Existing tenant or identity denial action | Actor/attempted permission, safe reason and request correlation; before/after null | Best effort denial recording; refusal preserved on audit outage |
| Post-rollback failure | Tenant / authorization.denied | Attempted action, failed flag, safe code, no SQL/error text | Written after rollback; original error retained |

Existing identity actions (sign-in, reset issuance/reuse) and read-only platform
support/technical/auditor access retain their existing audit contracts and
consumers. This task strengthens sensitive mutations, not a new activity system.

## Unimplemented features and required future integration

No operational wallet credit/debit/adjustment/refund/reversal service exists.
Ledger entries remain append-only and balances projections; pending top-up
requests never credit funds. Future financial writers must commit ledger entries
and audit evidence together with exact amount/currency, authenticated actor,
reason, business/idempotency identity and compensating-entry references.

No subscription/plan model or plan-assignment service, general platform-role
management API, account reactivation/suspension administration API, emergency
override/restart, real provider calling or charging is added. Raw suspension/
role setters are persistence seams, not standalone authorized operational APIs;
future entry points must use audited orchestration, not expose raw setters.

Contacts/calls remain internal persistence without customer, worker or provider
ingress. Call events remain their own append-only business history. Future
dispatch/callback integration must establish verified tenant/actor context.
The billing-duration ceiling remains provisional pending provider tariffs.

## Reason, privacy and compatibility

Existing clients omit administrative reasons. They receive specific documented
server purpose codes with reasonSource=server, not fabricated human motivation.
An optional reason object accepts routine_administration, security_incident,
membership_request, correction or customer_request and a bounded justification.
Malformed supplied reasons fail before mutation. Obvious credential-bearing
justifications are redacted. The emergency-stop reason remains mandatory under
its existing reason-code registry. Requiring human justification everywhere is
an explicit future API compatibility decision, not silently imposed here.

Metadata is projected and recursively checked for normalized credential keys,
cycles, non-JSON values and size bounds. No passwords, activation/reset tokens,
payment credentials or raw provider payloads are copied into mutation states.
Editable names and billing details use digests to reduce retained personal data.
Digests are not encryption or a tamper-evident chain; low-entropy values can be
guessed. Existing historical metadata remains unchanged. Human operators must
never put secrets into free text; arbitrary secrets cannot all be identified
by pattern matching alone.

Server-generated request IDs are returned in x-request-id and isolated through
AsyncLocalStorage. Incoming actor/tenant/request-ID/timestamp fields never
establish authority. CLI operations retain existing operation IDs where
available and do not fabricate an HTTP session.

First-owner bootstrap necessarily has no existing application actor: its
approved external-operator evidence is retained explicitly. The legacy local
Owner tool and low-level provisioning context are environment/operator workflows,
not proof of an authenticated human application identity. General authenticated
operator-management workflows remain a future requirement, not a new capability.

## Integrity and retention limits

Ordinary application UPDATE/DELETE and now TRUNCATE of either audit table fail.
Required audit INSERT failures roll back supported mutations. Denials/failures
are attempted after rollback and never marked SUCCESS; storage outages can
prevent that secondary record, in which case a fixed diagnostic is emitted.
No availability promise can make an unavailable database retain an event.

Database owners/superusers or infrastructure administrators can alter/disable
DDL controls. Absolute immutability is not claimed. No automatic history purge,
off-site audit service, infrastructure or backup system is added. Retention/
erasure policy and production DB least-privilege review remain governance/
operator requirements. Normal application updates retain history.

## Additive migration SQL review and approval gate

Migration: 20261021150000_sensitive_audit_integrity.
Canonical LF SQL SHA-256: 7b71c0e2e282bfbe04e057a7382906a366445285451bd201b1800aea489bae1f

Two BEFORE TRUNCATE statement triggers reuse the existing append-only function
inside BEGIN/COMMIT. No table/column/enum rewrite, data UPDATE/DELETE, DROP,
backfill, history scan or previously applied SQL edit occurs. Prisma cannot
model custom triggers, so this is explicitly authored/reviewed SQL, not a claim
that migrate diff generated controls it cannot represent.

CREATE TRIGGER needs table DDL locks. The existing controlled executor's
lock_timeout bounds each wait, not total lock holding; production timing and
blocking require operator review. Current application writers are compatible:
normal application operation does not truncate audit history. Code rollback
retains guards and history. Removing safeguards or restoring production data
requires separately reviewed approval; no destructive automatic down migration.

The production migrations-reviewed.json is unchanged and does NOT approve this
migration. Deployment must remain blocked until separate SQL/recovery/lock/
rollout approval is reviewed and merged. Disposable CI rehearses it through the
existing security harness, whose exact migration inventory is updated without
weakening its refusal of later unreviewed migrations.

Operator-only local provisioning now records the server OS account through userInfo(), with actorAuthentication=operating_system. That identifies the execution account, not necessarily a human behind a shared account. Existing subject-FK attribution is explicitly marked provisioning_context/local_operator; it is never presented as an authenticated application session. The approved external-operator references on first Platform Owner bootstrap remain unchanged.

The existing PostgreSQL occurred_at default records transaction time, not guaranteed commit order. Concurrent before/after chains and locking are authoritative; timestamps alone are not a monotonic ordering or tamper-evident sequence. Unknown/unauthenticated identities are rejected without fabricating an audit actor. New invitation audits retain an email digest rather than copying recipient email; historical records and action names remain unchanged. Optional emergency justifications use the same bounded redaction helper.
