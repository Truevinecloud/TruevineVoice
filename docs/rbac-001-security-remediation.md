# RBAC-001 security remediation — 2026-10-16

Recommendation: **NOT MERGE READY for draft PR #13 as currently published**.
The local remediation passes the checks below; the remote still points to
`087b190141fff16fc93d403fb018aada3f167dac`. New code requires reviewer approval
and fresh CI after an independently authorized push. No push was performed.
`DEPLOYMENT_READY=false`; no production database, accounts or deployment changed.

## Root causes and remedies

| Defect | Cause | Remediation |
| --- | --- | --- |
| Invitation race and wrong identity | Membership written before an unconditional/late claim; recipient identity not enforced | Organization row lock, conditional single-use claim and membership in one transaction; ACTIVE authenticated email match; database acceptance identity and inviter-scope triggers |
| Multiple Owners | Independent promote/demote transactions; no database invariant | Fresh authority under organization lock, demote then promote atomically; partial unique Owner index plus deferred exactly-one constraint triggers |
| Reset inconsistency | Password, token and revocations had separate commit boundaries | User lock, conditional unexpired claim, password change, all session revocations and audit in one transaction; replay cannot revoke a later valid session |
| Nonpersistent login protection | Rate limiting alone did not persist account failures across API instances | Database row-locked failure counter, bounded temporary lockout, uniform invalid-credentials responses and password verification; active locks cannot be extended by attempts; existing Redis IP limits retained |
| Terms bypass | Protected API handlers did not consistently require current acceptance | Server guard metadata on customer organization endpoints, including invitation acceptance; explicit authentication, identity, recovery and terms exceptions documented in ADR 0010 |
| Audit inconsistency | Successful mutations could commit before audit insertion | Transaction-bound stores for sensitive mutations and success audits; failed audit inserts roll back changes; actual refusals recorded as DENIED, never SUCCESS |

Prior Prisma 7.10.1 alignment, 12-hour cookie wire lifetime, malformed-cookie
handling, constant-time CSRF comparison and their regression tests are preserved.
The HTTP 204 proxy fix and frontend tests remain intact. No lint rules or tests
were disabled. ESLint 10 remains; no unsupported downgrade or peer override.

## Before and after: real PostgreSQL

The original store was first probed before implementation: invitation acceptance
left two memberships despite only one successful claim; concurrent transfers
both succeeded and left two Owners. Fixtures were removed afterward.

`npm run test:security:baseline` then compiled the frozen original store from
087b190 against disposable pre-remediation schema. The same two regression tests
**failed**, genuinely: duplicate membership race and two successful transfers.
This expected red command is retained, not converted into a passing assertion.

After remediation, both store regression tests pass (10 invitation rounds with
four contenders; 10 transfer rounds with two contenders). The HTTP suite also
runs 10 invitation rounds with eight intended-account requests and a wrong-account
attempt, and 10 transfer rounds with two contenders. Exactly one acceptance,
intended membership, transfer success and Owner survive each applicable race.
Transfer versus removal/demotion and acceptance versus revocation are repeated
10 times each. Expired invitations, wrong identities and cross-tenant attempts
are rejected. Database constraints reject zero/multiple Owners, Owner invitations,
foreign inviters and mismatched recipients.

Reset tests use independent Prisma clients, concurrent consumption and real
database audit-failure triggers. They verify rollback of password/token/session
changes, successful retry, old-session invalidation and safe replay. Audit-failure
tests also roll back profile, transfer and invitation membership/claim changes.
Concurrent sign-out records exactly one revocation success event.

Persistent lockout is tested with independent clients and actual API processes:
three failed attempts, process stop/restart, two more failures, then two live
instances both denying the correct password during the stored lock. That test
uses its own disposable Redis container with the real limiter enabled. The
focused HTTP race fixture substitutes the IP limiter only to isolate database
invariants; it does not substitute PostgreSQL or per-account protection.

## Migration safety

The original four RBAC migrations were not edited. Added migrations:

- `packages/database/prisma/migrations/20261016170000_security_atomicity/migration.sql`
- `packages/database/prisma/migrations/20261016171000_invitation_origin/migration.sql`

The first adds reviewed SQL-owned constraints/triggers and preflight refusal;
the second adds insertion-time inviter membership validation. They perform no
customer data repair or deletion. Applied rehearsal SQL was never rewritten.

Five rehearsals pass: all seven repository migrations deployed into an empty
disposable database using Prisma; representative existing data preserved; multiple
Owners, mismatched accepted identity and ownerless organizations each refused
with actionable errors and no partial schema/data writes. Databases are generated
and recorded by the runner; existing development databases are not reset.

All six RBAC migrations remain absent from `infrastructure/migrations-reviewed.json`.
Production deployment remains gated on manual approval. Old RBAC writers must be
stopped/upgraded before the unique index (their promote-first transfer conflicts).
Production dataset, lock duration, backup/restore and supervised recovery require
operator review. Constraints owned by SQL must be retained in future Prisma diffs.

## Final automated verification

| Command | Result |
| --- | --- |
| `npm run lint` | Passed, no rule relaxation |
| `npm run typecheck` | Passed across workspaces |
| `npm run prisma:validate` | Passed |
| `npm test` | 456 passed, three existing Windows-specific skips |
| `npm run test:security` | Five migration checks; 83 integration tests passed: API 45, worker 5, database 33; no integration skips |
| `npm run build` | Packages and all four production applications built |
| `npm audit --json` | Nonzero: five high development dependency findings remain |
| `npm audit --omit=dev --json` | Passed: zero production findings |
| `npm ls prisma @prisma/client @prisma/adapter-pg` | All aligned at 7.10.1 |

The 61 web tests are part of the 456. This is not browser automation. Browser
verification was not performed in this remediation session; the complete visual
activation journey still needs browser sign-off. HTTP integration is reported
only as HTTP integration. Linux-only db-verify and backup runtime suites explicitly
skip on Windows; their static tests run. No new skip was introduced.

Early runs found outdated hardcoded database-name/ownerless-fixture expectations
and old distinguishable login statuses. Fixtures now respect the explicitly requested
exactly-one Owner contract and non-enumerating login response. The old persisted
ownerless provisioning expectation is replaced by rejection/rollback assertions.
The health test retains its default name check and permits only the runner's
strict disposable name. These failures were corrected and the full suites rerun.

Significant commands, in execution order (routine source reads omitted):

1. Read README, AGENTS, ADRs, existing code/tests and current diff; original real-store race probe reproduced both defects.
2. Added transactional stores, service/guard changes, migrations and tests; `npm run test:security:baseline` failed two original race assertions as expected.
3. Ran targeted API tests and repeated `npm run test:security`; corrected the fixture/contract failures described above, then passed.
4. Ran lint/typecheck; corrected new lint/type errors without suppressions; reran successfully.
5. Ran final `npm run lint`, `npm run typecheck`, `npm run prisma:validate`, `npm test`, `npm run test:security` and `npm run build`; all passed with the stated platform skips.
6. Ran both audit commands and Prisma dependency tree; results above. PowerShell recorded Prisma's informational stderr as NativeCommandError text, but Prisma validation and its process exit succeeded.
7. Read `gh pr view 13 --json url,isDraft,headRefOid,state` and `gh variable get DEPLOYMENT_READY`: OPEN draft at old SHA; false.
8. Scanned branch history and current changes for credential patterns and captured activation/reset tokens; staged only repository sources/docs, then committed locally. See delivery response for commit SHA.

## Remaining review and production dependencies

Merge: remote PR lacks these fixes and fresh CI. Review the transactional locking,
SQL triggers and changed security contracts before approving. Five development-only
high advisories in the braces/ESLint configuration chain and plugin peer ranges
remain documented in the earlier dependency review; available suggested downgrades
are not safe supported fixes. The production audit is clean, not the full audit.

Production: approved legal text and canonical URL for the current terms version;
real email delivery/configuration; browser activation/ownership journey; suspended
account recovery/reactivation authorization policy; audit retention, access and
erasure policy; migration approval/recovery and production ingress/rate-limit review.
Failed mail delivery occurs after commit and does not falsely roll back a completed
database action. No new first-time invitee registration or automatic suspended-user
reactivation was added. No claim of formal timing or denial-of-service proof is made.
Existing audit immutability and tenant boundaries remain enforced.

## Changed files

- `.github/workflows/ci.yml`, `README.md`, `package.json`, `package-lock.json`
- `apps/api/src/auth/{auth.controller,auth.module,auth.service,auth.store,cookies,prisma-stores,rate-limiter,security-transaction,session.guard}.ts`
- `apps/api/src/organizations/{organizations.controller,organizations.service}.ts`
- `apps/api/test/{auth.service.spec,authorization.e2e-spec,authorization.guard.spec,cookies.spec,health.infrastructure.e2e-spec,route-guards.spec,security-remediation.e2e-spec,store-races.e2e-spec}.ts`
- `apps/api/test/fakes/auth.fakes.ts`
- `packages/database/package.json`, `packages/database/prisma/schema.prisma`, the two migration paths above
- `packages/database/test/{identity,provisioning}.e2e-spec.ts`
- `infrastructure/scripts/run-security-tests.mjs`
- `docs/adr/{0009-authorization-and-audit,0010-rbac-001-security-transactions}.md`
- `docs/{migrations-rbac-001-review,release-blockers,rbac-001-merge-readiness-review,rbac-001-security-remediation}.md`

No RBAC-002 work was started. No production action, merge or push was performed.
