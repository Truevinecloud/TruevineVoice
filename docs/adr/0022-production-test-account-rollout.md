# ADR 0022: Explicit operator workflow for production test accounts

Status: implemented for review; production execution approval withheld.

Commercial prelaunch does not turn the public deployment into development.
Keep the existing isolated seeder, immutable first-owner bootstrap and deployment
workflow unchanged. Use a separate disabled-by-default Linux operator CLI,
never an endpoint/startup/deploy hook. Approved active release markers, exact
production origin, independent expiring approvals, inventory/release/operation
binding, current owner credentials, database name and PostgreSQL system identifier
are mandatory. Private JSON files use the existing protected bootstrap reader.
JSON authorization fields record external human approval; they cannot supply it.

First-owner creation delegates to ADR 0014's mechanism. Its one-time token is
consumed privately through the existing audited CSRF-protected HTTP completion
contract with a custodian-controlled password; no emailed/tester-facing link or
alternate bootstrap/claim is introduced. Existing owner/password conflicts refuse.

The other ten accounts and two dedicated synthetic tenants commit together with
append-only identity audits. The completed provision audit uses the approved
operation UUID as its database primary key: existing uniqueness plus a fixed
advisory transaction lock and serializable preflight fence retries/concurrency
without a new schema. That record binds exact role/user/tenant IDs, inventory,
bootstrap and initial release. A later approved active tool release may verify or
disable the original batch by its initial release and operation provenance.
Unrelated matching emails/slugs are never adopted. No audit or claim is deleted.

Actual native HTTP verification is separate from database verification. It checks
deployed version before sending credentials, uses private isolated jars, refuses
redirects/failed TLS/throttling/missing terms, and records safe results only.
It does not assert privileged mutations, absent product surfaces or browser UI
success. Synthetic test mode permits loopback HTTP only under explicit disposable
target opt-in; production HTTPS settings remain unchanged.

Disable suspends the ten batch-owned identities and revokes their auth sessions,
tokens and fixture-scoped support rows. Authentication revocation also invalidates
other support contexts without tenant-unscoped row mutation. Existing QA Owner and
the sole bootstrap owner are preserved; owner retirement requires separate lifecycle
authorization. Code rollback never rolls back identities/audits/claim. Unknown
commit outcomes are reconciled, not blindly retried with fresh operation IDs.

No schema/migration, dependency, permission grant or CI workflow change is required.
Isolated real PostgreSQL/HTTP, Linux private-file and HTTPS evidence plus independent
release/bootstrap/execution approvals remain prerequisites to production use.
