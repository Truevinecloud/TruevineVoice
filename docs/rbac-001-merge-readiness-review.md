# RBAC-001 merge readiness review

> Security-remediation update: see [ADR 0010](adr/0010-rbac-001-security-transactions.md) and the [remediation report](rbac-001-security-remediation.md). Earlier defect findings are historical; migration production approval and release dependencies remain withheld.


Date: 2026-10-16. Recommendation: **NOT MERGE READY**.

Reviewed draft PR #13 at `087b190141fff16fc93d403fb018aada3f167dac`.
The fixes in this review are local and uncommitted; the PR's earlier green CI
does not cover them. No merge, push, production action or migration was performed
in this review. `DEPLOYMENT_READY=false`; PR #13 remains OPEN and draft.

## Findings that block merging

### P1: One invitation token can create two memberships

In `apps/api/src/auth/prisma-stores.ts:423`, `acceptInvitation` reads the token,
upserts membership, then conditionally claims the token. A failed claim returns
`{ ok: false }` from the transaction, which **commits** the membership already
created. The claim also omits revoked/expiry predicates, allowing revocation or
expiry to race acceptance. `OrganizationsService.acceptInvitation` throws only
after this transaction has committed.

Executed a deterministic two-transaction probe against local PostgreSQL using
the real compiled store, with a read barrier to make both transactions observe
the unused invitation. No production infrastructure was involved:

```json
{"isolation":"read committed","acceptanceResults":[{"ok":true},{"ok":false}],"membershipsCreated":2}
```

This is an executed failure of the single-use security invariant, despite green
ordinary tests. Claim the invitation conditionally before membership creation,
within the same transaction; a failed claim must leave no membership. Validate
revoked/expiry state in that claim. Add concurrent acceptance/revocation tests.

### P1: Concurrent transfers create multiple Owners

In `apps/api/src/auth/prisma-stores.ts:346`, `transferOwnership` reads the current
Owner and later updates by composite identity without a role/version predicate
or row lock. A transaction alone is not compare-and-set. The real-store probe
forced two reads of the same current Owner, then transferred to different members:

```json
{"transferResults":[{"ok":true},{"ok":true}],"finalOwnerCount":2}
```

Both transactions committed. This contradicts ADR 0009's explicit single-winner
guarantee. Membership role changes/removal also use unlocked read-then-write
sequences and can race transfer; last-owner counting is not sufficient at the
default isolation. Define one locking/conditional-update strategy for every
ownership/membership mutation, include retry behavior where required, and prove
transfer/transfer, transfer/demotion and transfer/removal races with real DB tests.
The latter two interleavings were identified by inspection, not executed here.

[PostgreSQL documents Read Committed as its default and its statement snapshots](https://www.postgresql.org/docs/current/transaction-iso.html).
The reproducer confirmed this isolation rather than assuming it.

### P1: Invitation recipient identity is not enforced; new-user onboarding is incomplete

`OrganizationsService.acceptInvitation` resolves a bearer token but never checks
that the signed-in user's normalized email matches `invitation.email`; the store
does not check it either. In the executed race, the second user had a different
email from the invitation recipient and still gained membership. The email field
and UI present a named-person invitation, not an explicitly shareable link.
Bind acceptance to the intended account, or obtain an explicit security/product
decision for bearer delegation. This is a security decision, not a silent refactor.

Separately, `/invitations/accept` requires an existing session; there is no
invitation-account activation path for a genuinely new email. Password-reset
requests for an unknown email create no account. Earlier journey verification
provisioned the teammate as an independent Owner first, so it did not prove
first-time invitee onboarding. Specify/implement that RBAC-001 contract and test
it without provisioning a second organization as a workaround.

### P1: Password change, token consumption and session revocation are not atomic

`apps/api/src/auth/auth.service.ts:248` consumes a token, hashes/updates the
password, revokes sessions and writes audit using separate database operations.
A failure after password update but before revocation leaves old sessions live:
`SessionGuard` checks account status/expiry/revocation but not
`passwordChangedAt`. Failure before password update can consume an activation
link without activating it. Concurrent reset issuance/completion has analogous
invalidation gaps. Hash before the short database transaction; commit token claim,
password change and session revocation atomically, with audit/outbox durability.
Add failure-injection and concurrent reset/sign-in tests. These failure windows
were found by inspection; no outage was injected into PostgreSQL in this review.

### P1: Per-account lockout is never installed

`PrismaAuthStore.recordFailedSignIn` at line 64 increments `failedLoginCount` but
does not set `lockedUntil`. `AuthService.signIn` computes a lockout timestamp only
for an audit event. Existing tests manually set `lockedUntil`, so they do not
prove that failed attempts cause lockout. IP-prefix rate limiting still works,
but does not replace the advertised per-account protection against distributed
attempts. Persist the threshold/lockout transition atomically; test reaching the
threshold, expiry and concurrent failures. No distributed attack was run.

### P2: Terms are enforced in the UI, not by organization API routes

`RequireAcceptedTerms` is defined in `permission.decorators.ts:52` and read by
`OrganizationGuard`, but a repository search found no route applying it.
`apps/web/src/app/app/layout.tsx` redirects an unaccepted user; direct API calls
can still use organization routes. Wire the agreed protected operations and add
HTTP tests with an unaccepted account. The missing legal document is a separate
deployment dependency; it does not justify omitting the API control.

### P2: Successful security actions and audit persistence can diverge

Organization mutations commit in store transactions and audit afterward in
`organizations.service.ts`; an audit failure returns an error after the action
has already succeeded. Sign-out revokes a session but records no identity audit
event at all. Denial best-effort logging is an explicitly documented tradeoff;
that does not establish atomic audit for successful role/ownership/token changes.
Add transactional audit or a durable transactional outbox and failure-injection
tests. This is code inspection, not a simulated audit-store outage.

### P2: Reactivation and repository contracts need resolution

Password-reset requests explicitly ignore SUSPENDED users, and reset completion
never sets ACTIVE. Therefore the documented self-deactivation recovery path is
unavailable at both issuance and completion. Do not silently allow resets to
undo administrative suspension: the shared SUSPENDED state needs a clear recovery
policy and regression tests before this lifecycle contract can be called complete.

Existing code also conflicts with binding AGENTS.md rules: infrastructure stores
inject the concrete `PrismaClient`, and
`findOutstandingInvitationByEmail(email)` loads tenant-owned invitations across
organizations without an organization predicate. The invitation's inviter FK
references a global user, not an organization-scoped membership. Resolve the
narrow-client/scoped-query contracts and explicitly decide the FK shape (historic
inviters can outlive membership). These were reported, not silently redesigned.

## Nine high audit entries investigated

The network-enabled baseline `npm audit --json` reproduced exactly nine high
affected-package entries. They represent three dependency chains, not nine
independent high-severity CVEs. The mysql2 entry additionally includes a moderate
compression advisory. An initial sandbox audit returned an empty report; that
was not accepted as evidence and was repeated with network access.

| Affected entry at PR HEAD | Installed version | Classification / exposure | Safe remediation and local result |
| --- | --- | --- | --- |
| `braces` | 3.0.3 | Dev-only; recursive glob-pattern stack exhaustion | No published patched version; retained with explicit exposure analysis |
| `micromatch` | 4.0.8 | Dev-only, propagates braces finding | Wait for supported parent/glob fix; no forced override |
| `fast-glob` | 3.3.1 | Dev-only, propagates micromatch/braces | Same chain |
| `@next/eslint-plugin-next` | 16.4.0 | Dev-only lint plugin, propagates fast-glob | Same chain |
| `eslint-config-next` | 16.4.0 | Direct dev dependency, propagates plugin finding | Do not downgrade to npm's proposed Next 14 lint config |
| `deepmerge-ts` | 7.1.5 | Prisma configuration merging; recursive graph exhaustion | Updated via Prisma patch to 8.0.2 |
| `@prisma/config` | 7.10.0 | Propagates deepmerge-ts; CLI/config use | Updated to 7.10.1 |
| `mysql2` | 3.15.3 | Prisma CLI dependency; auth downgrade and compressed-protocol DoS | Updated via Prisma patch to 3.24.4 |
| `prisma` | 7.10.0 | Direct dev CLI, also optional peer of production client | Updated CLI/client/pg adapter consistently to 7.10.1 |

Sources: [braces advisory, no patched version](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm),
[deepmerge-ts recursive merging](https://github.com/advisories/GHSA-ggr8-5vv4-36mx),
[mysql2 authentication downgrade](https://github.com/advisories/GHSA-3f6p-5ww8-9rcr),
[mysql2 compressed-protocol DoS](https://github.com/advisories/GHSA-rgwj-5xj2-c3m3).
Published npm metadata for Prisma 7.10.1 was checked before installation.

The braces path is `eslint-config-next -> @next/eslint-plugin-next -> fast-glob
-> micromatch -> braces`. It is absent from `npm audit --omit=dev`. No application
request path imports these packages or accepts user glob patterns; developer/CI
linting of a malicious checkout is the plausible exposure. It is not a demonstrated
production endpoint exploit. The existing deployment builds with dev tooling,
so supply-chain/build-host risk is not zero.

Prisma's four entries must **not** be dismissed as purely dev-only: the lockfile
marked them `devOptional`, because `@prisma/client` has an optional Prisma peer.
The production-only audit originally reported these four. The application uses
the PostgreSQL adapter, never mysql2; no remote request is mapped to Prisma config
merging. Thus vulnerable components were potentially installed in production,
but the vulnerable MySQL protocol/config inputs were not found on application
request paths. Patch them rather than rely on that limited reachability.

After the local patch: full audit **5 high**, production-only audit **0**.
No `npm audit fix --force`, unsupported deepmerge override or dependency removal
was used. The remaining dev chain requires risk acceptance/upstream tracking,
not a misleading zero-advisory claim. It does not outweigh the code merge blockers.

## ESLint peer warnings

Installed/latest plugin metadata remains: import 2.32.0 accepts ESLint through 9;
react 7.37.5 through 9.7; jsx-a11y 6.10.2 through 9. `eslint-config-next` itself
accepts >=9, typescript-eslint accepts 8.57/9/10, but those plugin peer ranges
exclude the pinned ESLint 10.12.0. `npm ls ... --all` exits ELSPROBLEMS, confirming
a real compatibility declaration conflict even though lint passes.

ESLint 9.39.5 plus matching `@eslint/js` could satisfy those peer ranges, but
[ESLint 9 reached EOL on 2026-08-06](https://eslint.org/version-support/).
Downgrading to EOL tooling, ignoring peers, overriding peer metadata or removing
rules is not a safe routine fix. Retained current pins and rules. Track supported
plugin releases or make a separately reviewed toolchain/LTS decision. This is a
dev-tool compatibility warning, not evidence of a runtime authentication defect.

## Four migrations: production safety review

None is approved for production; the approval manifest is untouched. No SQL file
was edited, because all four have already run in development/CI. Fixes to applied
SQL require new forward migrations and an operator-reviewed rollout plan.

| Migration suffix | Review result and production prerequisites |
| --- | --- |
| `130500_identity_rbac_001` | **Not an unconditional expand.** Replaces the role enum; OPERATOR has no mapping. Adds a user FK to existing memberships with no backfill, so pre-existing nonempty memberships can fail even if their roles cast. Validate the entire target dataset, reference integrity and deployed-writer compatibility. The SQL contains an inner enum transaction but is not one explicit transaction around the whole file; partial execution/recovery needs rehearsal. The documented rollback drops users before dropping memberships' user FK, and does not restore the enum, so it is not a valid general rollback. Add a reviewed forward/backfill strategy or prove and document the strictly empty-foundation prerequisite. This compatibility/rollback contract is a merge review concern, not merely missing credentials. |
| `141500_identity_audit_events` | Adds an identity audit table, indexes, FK and trigger dependent on migration 1's function/type. Additive for existing API reads. Initial CASCADE is effectively blocked by the append-only trigger; migration 3 corrects it. Rolling back by dropping populated audit history is unacceptable without a retention decision. |
| `142500_identity_audit_fk_restrict` | Changes CASCADE to RESTRICT, matching trigger behavior. DROP/ADD FK can lock and validate populated tables; the comment claiming no data is read is not a performance guarantee. Rehearse failure recovery and locks with production-like volume and preserve the audit trail. |
| `153000_organization_suspension` | Nullable no-default timestamp is an additive shape; partial index is a regular, non-concurrent build on an existing table. It can block writers. No blanket millisecond guarantee; rehearse locking and configure operator timeouts. Dropping the column after suspensions exist silently unsuspends tenants and is not a safe rollback. Partial index is absent from Prisma schema representation; verify drift with the chosen Prisma partial-index strategy before later schema generation. |

Corrections to earlier review assumptions: citext is a trusted extension and
[non-superusers with CREATE on the database may install it](https://www.postgresql.org/docs/current/citext.html).
DBA installation is needed only if the migration role lacks the required
privileges/extension availability. A regular
[CREATE INDEX blocks writes while allowing reads](https://www.postgresql.org/docs/current/sql-createindex.html).
It does not permit concurrent writes as the previous report stated.

The audit triggers reject UPDATE/DELETE, not TRUNCATE; a privileged table owner
can also disable triggers/drop tables. Use a least-privileged runtime role and
separate migration authority. Do not describe the triggers as protection against
all privileged operators. No destructive bypass was attempted in this review.

## Secret and sensitive-data review

Custom pattern and captured-token comparison scanned **278 distinct Git blobs
across all five branch commits**, including prior versions, not just HEAD. It
checked private-key headers, GitHub/AWS token formats, concrete activation/reset/
invitation token URLs, external database credentials and secret file paths; all
**31 locally captured tokens** were compared in memory without printing them.
Result: no hits. `.env`, capture directories and logs are ignored/untracked.
Committed passwords/emails are clearly synthetic test fixtures; loopback Compose
credentials are disposable development configuration, not production secrets.

This is bounded scanning, not a certified forensic scan or a guarantee about
every proprietary credential format. No gitleaks executable was available.
The first scanner parser mistakenly scanned zero blobs; it was corrected,
required a nonzero count and rerun. The zero-blob result was discarded.

## Low-risk fixes made locally

- Matching Prisma CLI/client/PostgreSQL adapter patch 7.10.1, lockfile and exact
  install-script approvals. No schema or migration changes.
- Cookie options now use Express milliseconds: serialized Max-Age is 43200
  seconds, rather than 43 seconds from the old `12 * 60 * 60` value.
- Malformed cookie percent encoding is treated as a missing credential instead
  of throwing URIError/500.
- CSRF comparison uses Node `timingSafeEqual` over fixed-length SHA-256 digests.
- Four new tests cover real Express serialization, malformed session and CSRF
  cookies, and token matching/refusal. No existing test or lint rule weakened.

The larger transaction, identity-policy and architectural corrections remain
unfixed merge blockers; the limited-fix instruction was not treated as approval
for a broad authentication redesign.

## Deployment-only prerequisites and remaining verification

These do not excuse the merge defects above:

- Actual versioned legal terms, canonical URL and acceptance-retention policy.
- Production transactional email credentials/configuration and actual delivery
  verification; development capture is not production delivery. Unknown transport
  strings currently fall through to null delivery and need fail-fast hardening.
- Human approval of each migration, staging rehearsal, backup/restore and recovery
  plan, privilege split and target data/lock checks. The interlock remains closed.
- Retention, erasure/anonymization, lawful basis and audit access policy. Platform
  denial audit remains a documented RBAC-002 dependency; no RBAC-002 work started.
- Real browser activation, invitation, ownership and sign-out journey, including
  Secure cookies, expiry, hydration and CSRF behavior. Prior HTTP harness results
  are not browser-level verification. No browser testing was run in this review.
- Recovery for self-deactivation vs administrative suspension must be decided;
  the code-contract defect is a merge blocker, while operational policy approval
  is also a release prerequisite.

## Validation and command record

Local results after fixes: lint, typecheck, Prisma generate/validate and all
production builds passed. `npm test`: **455 passed, 3 existing Windows skips**;
API unit count increased from 122 to 126. The two POSIX runtime suites reported
SKIP on Windows. API/database/worker integration tests: **68 passed, 0 skipped**.
The two executed security invariants failed as documented above; passing ordinary
suites does not override those failures. Full audit intentionally exits nonzero
for the five unresolved dev findings; production-only audit exits zero.

Significant commands in execution order (raw outputs retained only under ignored
`.deployment-validation/`):

1. Read README, AGENTS, package scripts, release blockers; `git status` - inspected clean starting tree.
2. `npm audit --json` in sandbox - empty result, not accepted; network-enabled retry reproduced nine high entries.
3. Read auth/services/stores/guards/cookies, tests, ADRs and all four migration SQL files; searched permission use and tenant predicates.
4. `npm ls eslint eslint-plugin-import eslint-plugin-react eslint-plugin-jsx-a11y --all` - ELSPROBLEMS; reviewed exact peer ranges.
5. `npm view` for plugin versions, ESLint 9, braces and Prisma 7.10.1 packages/dependencies - metadata verified. A package.json subpath read hit ERR_PACKAGE_PATH_NOT_EXPORTED; direct file read succeeded.
6. `npm audit --omit=dev --json`; `npm explain braces deepmerge-ts mysql2` - four production-reachable optional-peer entries and paths confirmed before patch.
7. Read primary GitHub advisory, ESLint support and PostgreSQL/Prisma transaction documentation.
8. Updated exact Prisma pins/approvals; `npm install` - succeeded, five remaining high dev findings; peer warnings retained.
9. Applied cookie fixes and four regression tests.
10. `npm run prisma:generate`; `npm run prisma:validate`; `npm run lint` - passed.
11. Full/production-only `npm audit --json` after patch - five/zero respectively.
12. `npm test`; `npm run typecheck`; `npm run test:e2e`; `npm run build` - passed with the Windows skips described above.
13. Custom historical secret scan - corrected zero-blob parser and reran: 278 blobs, 31 captured tokens compared, zero hits.
14. Custom local real-store concurrency probe - first import failed before fixtures; corrected imports and reran: both security invariant failures reproduced; own fixtures removed in finally.
15. `gh pr view 13`; `gh variable get DEPLOYMENT_READY` - OPEN/draft, unchanged head SHA, false.

No local fixes were committed or pushed because this review request did not
explicitly request committing them. PR CI still refers to the previously pushed
head; fresh CI is needed after reviewed fixes are eventually committed/pushed.

## Files created or changed in this review

- `apps/api/src/auth/cookies.ts`
- `apps/api/test/cookies.spec.ts`
- `package.json`
- `package-lock.json`
- `packages/database/package.json`
- `README.md`
- `docs/migrations-rbac-001-review.md`
- `docs/release-blockers.md`
- `docs/rbac-001-merge-readiness-review.md`

Ignored local diagnostics: `.deployment-validation/rbac-review-*` logs, advisory
snapshots, race reproducer/results and secret scanner/results. No captured tokens
or environment values were added to this report or to tracked files.
