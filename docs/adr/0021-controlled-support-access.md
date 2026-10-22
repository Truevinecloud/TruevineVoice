# ADR 0021: Temporary, scoped support access

- Task: RBAC-014
- Status: Proposed for review; production migration approval withheld
- Date: 2026-10-22
- Extends ADRs 0009, 0019 and 0020

Customer impersonation is not a valid authentication mode. A support operator remains the authenticated actor and may hold a separate, short-lived capability scoped to one organization. Only the explicitly assigned `SUPPORT_ADMIN` role may create it with a mandatory reason code. The context expires after 15 minutes, is persisted as a token hash bound to the operator's current auth session, and is revalidated on every request.

The existing tenant-diagnostics route is the only context data route and now requires both support-access and diagnostics permissions. Its organization path must match the persisted context. Customer roles and permissions are never loaded or inherited. Creation and termination/observed expiry are transactionally audited; context reads are recorded against the tenant with the real operator, context ID and reason. The audited state does not claim protection from database superusers.

The additive support-session migration requires separate SQL, recovery and production approval before release. In-flight reads may complete if they were authorized immediately before concurrent revocation; later requests are denied. Future expansion of the allowlist, browser behavior or asynchronous work requires separate review.

See [RBAC-014 security and implementation record](../rbac-014-customer-impersonation-security.md).
