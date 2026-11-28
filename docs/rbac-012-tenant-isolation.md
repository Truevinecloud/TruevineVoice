# RBAC-012: tenant isolation

Status: implementation complete locally; browser release verification is blocked.
Baseline: a6f74b0 on the existing `feat/rbac-010-technical-admin` branch.
No deployment or push is authorized by this document.

## Security architecture

The API is the authorization boundary. A browser URL selects a requested
organization; it never proves access. `SessionGuard` resolves the HTTP-only
session, checks expiry/revocation and active user status, and reads current
platform authority. `OrganizationGuard` then loads the authenticated user's
membership for the organization in the **path**, checks organization suspension,
current terms and the required organization permission. Only that decision
populates `CurrentOrganization`. Body/query `org_id`, `organizationId`, actor IDs
and nested IDs cannot replace the authorized context.

Missing permission metadata and non-HTTP guard contexts fail closed. No
membership and a nonexistent organization produce the same 403. Nested resources
not found in the authorized organization produce 404 without a foreign record's
identity or content. Client-supplied scope fields are either rejected by strict
input validation or ignored during explicit projection; an accepted request to
A with a forged body scope still creates only in A for the verified actor.

Organization and platform permissions remain separate. Platform Owner has no
implicit membership bypass on customer endpoints. Platform operations, Support,
Technical, Billing Admin, payment configuration and Auditor routes retain their
explicit permission and projection rules. Auditor's four read permissions and
Technical Admin's bounded audit projection are unchanged. Support diagnostics
still require the existing reason-bound, scoped support capability.

### Resource inventory and enforcement

| Resource family | Isolation and authorization |
| --- | --- |
| Organization profiles/settings | Guarded path membership; fresh authorization inside profile-update transaction |
| Members, invitations and ownership | Tenant/member composite keys, transaction-time delegation checks and owner invariants; invitation acceptance separately requires the verified token and matching active identity |
| Contacts and contact groups | Organization-scoped lists, cursors, edits/deletes and nested group/contact lookups; composite membership FKs; every contact/group mutation rechecks authority under the organization lock |
| Contact imports and batches | Organization/import composite keys; scoped summaries and replay state; import permission rechecked for start, batch and completion, including no-op retries |
| Campaigns, audience groups and reports | Scoped reads/aggregates; transaction-time write authorization; composite organization/campaign/group/audio references; no execution or outbound calling added |
| Audio assets, recordings and TTS preparation | Scoped assets/operations and playback targets; tenant-leading references and immutable usage evidence; existing transactional audio authorization retained; content downloads are private/no-store |
| Wallet, billing and pending top-ups | Scoped aggregates, pagination anchors and profile reads; immutable ledger and tenant-scoped idempotency; fresh billing authority for writes |
| Pending payment intents | Verified actor forwarded from controller to repository; organization lock and fresh billing permission before lookup, replay or creation; organization/key uniqueness and scoped ID lookups |
| Payment attempts/events and wallet references | Existing organization/intent composite relations; no provider initiation, webhook, settlement or charge path added |
| Recipients, executions, call attempts/operations/events | Existing composite tenant/parent lineage FKs, immutable snapshots/history and durable tenant-scoped idempotency; internal persistence has no registered HTTP/worker/provider ingress |
| Security audit | Tenant-scoped records and append-only evidence; platform readers use explicitly permitted platform projections, never unrestricted customer authority |

Global identity records remain user/platform scoped: users, sessions, password
reset tokens, terms acceptances, platform role assignments, identity audits and
bootstrap claims. `/me` discovers only the verified user's memberships. It now
also projects `organizationStatus` so suspended workspaces are not offered as
available selections.

No schema or migration change is needed. Existing composite foreign keys enforce
related-row tenant ownership; they do not automatically filter SELECT queries.
Every reachable repository still supplies the authorized organization scope.
The unused legacy raw tenant-client placeholder is not an authorization boundary.
No database RLS guarantee is claimed. See ADRs 0006, 0009, 0010, 0018 and 0019.

## Gaps closed in this change

1. Settings, team, invite and invitation pages silently fell back to the first
   organization for an unrecognized URL ID. All tenant pages now use one
   fail-closed membership selector. Only an absent organization parameter defaults
   to the first available membership. Empty, foreign, suspended and ambiguous
   repeated parameters never select another organization implicitly.
2. Stateful campaign/audio/billing/settings/invitation components could retain
   another authorized organization's drafts or records when props changed. Tenant
   content is now keyed by identity, organization, role and permissions, with
   explicit keys at the individual stateful page boundaries as well.
3. Navigation silently showed the first organization for invalid context. It now
   shows an unavailable state, authorized choices and a safe return path. Account
   links preserve the URL's valid workspace context.
4. Several contact/import mutations and payment intents trusted an earlier guard
   decision through their transaction. They now use the existing
   `authorizeTenantWrite` organization lock, fresh membership/active-user check,
   permission check and membership/user share locks before any business write or
   replay. Payment-intent concurrency serializes on the same lock. No role from
   the browser is trusted.
5. Older RBAC-012 coverage predated contact/group/import/audio/payment endpoints.
   The release matrix now includes these real HTTP routes, scoped repositories,
   two tenants, distinct users, allowed reads, nested attacks, idempotency and
   before/after business snapshots.

## Frontend organization context

The existing `?organization=<id>` model is retained; there is no global active
organization stored in localStorage, cookies or session state. Separate tabs can
work in different organizations. Server pages resolve the URL against the
session memberships before fetching. All server and browser tenant requests
remain no-store and include an explicit organization path.

`OrganizationWorkspace` integrates into the real authenticated layout and
existing navigation. Before switching, it checks fresh `/me` membership and
session identity, then navigates to the authorized dashboard and refreshes
server data. The previous tenant subtree is removed while switching, so pending
callbacks cannot overwrite the next tenant's UI. The switcher is disabled while
verification is pending and failures provide a safe recovery state.

Cached routes, browser-history changes and restored/visible tabs revalidate
membership before revealing tenant content. Revoked/suspended memberships hide
content; changed permissions refresh the server view; session expiration hides
private content and provides sign-in. Aborted or superseded verification cannot
release stale data. Stateful content remounts on scope changes. Audio recording
cleanup stops microphone tracks and discards recordings without auto-saving into
the previous workspace, including delayed microphone permission results.

The interface uses existing typography, cards, role-aware navigation and brand
colors. Loading skeletons are responsive and have accessible status text;
forbidden/error states avoid foreign organization details and offer a safe
workspace link. No decorative isolation page, mock authorization, hardcoded
production tenant or frontend-only security check is introduced.

An authorized in-flight server read/write may complete before a later
revocation or navigation; this is not retroactive cancellation of committed
work. Writes serialize with membership changes per ADR 0019. Subsequent API
requests and cached UI verification recheck authority. Backend checks remain
necessary even when a frontend state is hidden.

## Attack scenarios and regression coverage

- A/B reads with independent users and role permissions; no-membership and
  unauthenticated callers; multi-membership users with different roles.
- Forged path/body/query organization IDs and actor IDs; missing/foreign IDs
  have indistinguishable refusals. Mutations leave business snapshots unchanged.
- Guessed campaign/member/invitation/contact/group/import/audio identifiers,
  mixed nested group/contact pairs, campaign audio/group ownership and wallet
  pagination anchors.
- Contact filtering/cursors, reports/aggregates and tenant-scoped search data;
  no foreign records leak through a filter or a result page.
- Real HTTP audio content downloads: own assets succeed, foreign asset IDs and
  foreign organization paths fail. A synthetic in-memory object adapter avoids
  external storage/providers while PostgreSQL and API guards remain real.
- Pending payment idempotency across tenants, identical concurrent retries,
  denied nonmember persistence, replay after membership removal and contact
  writes after role downgrade.
- Database composite FK, immutable ledger, call lineage/event/idempotency and
  existing authorization race contracts.
- Frontend direct forged links across all eleven tenant pages, fail-closed
  selection, suspended options, pending switch requests, drafts on history
  changes, restored-tab revocation, session expiry and microphone cleanup.

No customer export endpoint currently exists. No claim is made that a missing
export or provider route proves a functioning export/provider integration safe.
The existing explicit no-ingress assertions remain separate from the positive
resource-family authorization tests.

## Commands and QA fixtures

Developer entry points (from repository root):

- `npm.cmd run lint`
- `npm.cmd run typecheck`
- `npm.cmd test`
- `npm.cmd run build`
- `npm.cmd run test:rbac-012:qa`

Use `npm` instead of `npm.cmd` on shells where the PowerShell npm.ps1 execution
policy does not apply. The usual `test:tenant-isolation:e2e` command remains
available for separately provisioned disposable CI infrastructure; this task uses
the pinned QA runner and does not run the destructive security harness.

The QA runner derives connection credentials in memory from local environment
configuration, requires loopback PostgreSQL port 55432, refuses production/staging
and routing options, and pins the database to
`truevine_bootstrap_test_a1b2c3d4e5f67890`. Only the ordinary `schema=public` query
option is accepted and removed. It never connects to the source development
database. Before spawning tests it verifies `current_database()` on the live
connection. Each selected suite also verifies its connected name before writes.
`RBAC_ISOLATED_QA=1` pins the shared test guard to this exact name and explicitly
refuses `truevine_voice`, any other database, and non-test environments.

The reviewed suite list is authorization, tenant-isolation, organization-admin,
contacts, contact-groups, campaigns, audio-assets, billing, billing-admin,
payment-intents and call-persistence. Fixtures use fresh UUIDs and synthetic
users/organizations. Existing QA accounts, memberships and credentials are never
reset or reused. Cleanup is limited to mutable fixtures owned by the individual
run. Immutable audits, ledger and related synthetic evidence remain in QA.
No migrations, database creation/drop/reset or shared-table truncation occurs.
No external email, voice, storage or payment operation is performed. Rate
limiting uses test adapters where the existing suites require them. The API
integration suites do not require a live Redis dependency.

The runner validates target identity, not migration approval. Missing schema or
infrastructure fails loudly. It does not migrate the database or fall back to
`truevine_voice`. Never manually repoint E2E at a shared development database.

## Verification record and release checklist

The ordered command/results record is in the delivery report below. Browser QA
could not initialize: both browser CUA and the Node/Computer Use fallback returned
`failed to write kernel assets: The system cannot find the path specified.
(os error 3)`. No browser login, desktop/mobile visual inspection or interactive
browser switching was performed. Component/SSR tests are not browser QA.

- [x] Audited guards, scoped queries, nested relations and platform exceptions.
- [x] Reused existing architecture; no schema migration or new dependency.
- [x] Added server transaction-time authority and frontend context protections.
- [x] Cross-tenant PostgreSQL/HTTP suite passed locally (11 files, 194 tests).
- [x] Existing Admin/Auditor and tenant role regression suites passed.
- [x] Final lint/typecheck/test/build results recorded after the last changes.
- [ ] Authenticated browser switching, history and mobile/desktop visual QA.
- [ ] Release/deployment review (not authorized by this local implementation).

Release verdict: **NOT YET VERIFIED** until browser QA is completed. The
cross-tenant automated release blocker has passed; the environment limitation
must not be represented as a completed browser check.

## Delivery record (local)

Inspection preceded edits: README/AGENTS, current Git status and recent commits,
ADRs 0015/0016/0019, existing Admin/customer navigation, API authentication and
organization guards/controllers, scoped stores, Prisma schema/relations, tests,
and local Next.js client-component documentation. Read-only Docker queries
verified the exact QA database and existing required tables/migration names
before any fixture write. No migration was applied.

Commands ran in this order (repeated quality gates are recorded with their final
outcomes; independent gates sometimes ran concurrently):

1. `Get-Content`, `rg --files`, `rg`, `git status --short`, `git log -3 --oneline`:
   repository audit. A few initial file-path probes were absent; corrected using
   the repository inventory before editing.
2. `docker exec truevine-postgres psql -X -U truevine -d truevine_bootstrap_test_a1b2c3d4e5f67890 -tAc "SELECT current_database();"`:
   passed. A second read-only query verified required tables and applied migration
   names. The Docker read used approved access outside the sandbox.
3. `npm.cmd run test --workspace @truevine/web -- organization-isolation organization-context AppNavigation --maxWorkers=1`:
   41 passed.
4. `npm.cmd run test --workspace @truevine/api -- payment-intents disposable-database route-guards --maxWorkers=1`:
   65 passed.
5. `npm.cmd run test:rbac-012:qa`: first seven-suite run reported 144 passes but
   emitted a storage-fake shutdown error. The fake was corrected to satisfy the
   complete storage/lifecycle contract. The corrected seven-suite rerun passed
   144 tests without that error.
6. `npm.cmd run test --workspace @truevine/web -- OrganizationWorkspace organization-isolation organization-context AppNavigation --maxWorkers=1`:
   47 passed during implementation.
7. `npm.cmd run typecheck`: initially failed on tuple inference in the new
   E2E fixture arrays. Fixed using literal tuples without suppression; all later
   repository-wide reruns passed.
8. `npm.cmd run lint`: passed; the existing Billing Admin hook-dependency
   warning remains in apps/admin/src/app/billing/page.tsx. No new warning.
9. `npm.cmd run build`: passed for packages and all four apps; repeated after
   frontend changes and passed again.
10. Browser CUA inventory and the Node/Computer Use initialization fallback:
    both blocked by missing kernel assets, before any UI action or login.
11. `npm.cmd test`: full workspace and deployment suites passed. Repeated
    after frontend changes: final full run had 1,607 workspace passes (including
    878 API, 362 web and 113 Admin tests) plus 356 deployment passes. Three
    existing POSIX-only tests were skipped on Windows. Existing db-verify and
    backup runtime scripts reported their Windows skips; no skip was added.
12. `npm.cmd run test:rbac-012:qa`: expanded and final reruns passed all
    **194 tests in 11 suites**, including final business snapshots for audio
    operations/usage and payment attempts/events. Only the verified pinned QA
    database was used.
13. `npm.cmd run test --workspace @truevine/web -- OrganizationWorkspace organization-isolation organization-context audio-library --maxWorkers=1`:
    45 passed at that checkpoint. Final transition/session/draft refinements were
    then verified with `npm.cmd run test --workspace @truevine/web -- OrganizationWorkspace --maxWorkers=1`:
    **9 passed**.
14. `npm.cmd run build --workspace @truevine/web`: passed after the final
    workspace changes. Final `npm.cmd run typecheck` and `npm.cmd run lint`
    passed again. New files were formatted using the installed Prettier library;
    formatting did not touch unrelated files.
15. `git diff --check`, targeted diff review, `git diff --numstat`,
    `git remote -v` and branch inspection: no whitespace/security regression
    found. Generated Next.js environment declarations were restored to their
    pre-existing local dev references and excluded from staging.
16. Stage explicit RBAC-012 paths (the initial staged whitespace check found a trailing blank line in this document; corrected before commit) and only the RBAC-012 README/package hunks;
    review `git diff --cached --check`, `git diff --cached --stat` and
    `git diff --cached --name-only` before the focused local commit.
    Verify the commit with `git log -1 --oneline`, `git show --stat --oneline HEAD`
    and `git status --short`. No push/deployment.

The denial-audit messages in negative tests concern intentional nonexistent
targets or injected audit failures. They do not indicate suppressed authorization
failures. No assertion, timeout or test was weakened to pass.

### RBAC-012 file inventory

README.md and package.json contain pre-existing unrelated edits: only the new
RBAC-012 documentation/command hunks belong to this commit.

- `README.md`
- `package.json`
- `apps/api/src/contacts/prisma-contact.store.ts`
- `apps/api/src/organizations/organizations.controller.ts`
- `apps/api/src/organizations/organizations.service.ts`
- `apps/api/src/payments/payment-intents.controller.ts`
- `apps/api/src/payments/payment-intents.service.ts`
- `apps/api/src/payments/payment-intents.store.ts`
- `apps/api/src/payments/prisma-payment-intents.store.ts`
- `apps/api/test/disposable-database.spec.ts`
- `apps/api/test/disposable-database.ts`
- `apps/api/test/payment-intents.service.spec.ts`
- `apps/api/test/route-guards.spec.ts`
- `apps/api/test/tenant-isolation.e2e-spec.ts`
- `apps/web/src/app/app/AppNavigation.tsx`
- `apps/web/src/app/app/AppUI.tsx`
- `apps/web/src/app/app/OrganizationWorkspace.tsx`
- `apps/web/src/app/app/OrganizationWorkspace.spec.tsx`
- `apps/web/src/app/app/organization-isolation.spec.tsx`
- `apps/web/src/app/app/layout.tsx`
- `apps/web/src/app/app/page.tsx`
- `apps/web/src/app/app/audio/audio-library.tsx`
- `apps/web/src/app/app/audio/audio-library.spec.tsx`
- `apps/web/src/app/app/audio/page.tsx`
- `apps/web/src/app/app/billing/page.tsx`
- `apps/web/src/app/app/campaigns/page.tsx`
- `apps/web/src/app/app/contact-groups/page.tsx`
- `apps/web/src/app/app/contacts/page.tsx`
- `apps/web/src/app/app/invitations/page.tsx`
- `apps/web/src/app/app/reports/page.tsx`
- `apps/web/src/app/app/settings/page.tsx`
- `apps/web/src/app/app/team/invite/page.tsx`
- `apps/web/src/app/app/team/page.tsx`
- `apps/web/src/app/globals.css`
- `apps/web/src/lib/api.ts`
- `apps/web/src/lib/session.ts`
- `apps/web/src/lib/organization-context.ts`
- `apps/web/src/lib/organization-context.spec.ts`
- `docs/rbac-012-tenant-isolation.md`
- `infrastructure/scripts/run-tenant-isolation-qa.mjs`
- `infrastructure/scripts/run-tenant-isolation-qa.spec.ts`

### Remaining verification

Automated cross-tenant release gate: **PASS**. Browser/visual release gate:
**BLOCKED by local automation initialization**. Overall release verdict remains
**NOT YET VERIFIED**. Run authenticated desktop/mobile switching, denied direct
links, browser history and multi-tab checks on a workstation with functioning
browser automation before release.

Existing unrelated modifications and untracked files, including account recovery,
authentication configuration, Admin proxy and database client work, are preserved.
No root .env edit, existing account reset, development database connection,
schema change, production/staging operation, provider action, push or deployment
was performed by this task.
