# Production test-account rollout — review draft

Implementation update: executable tooling now exists. Use the
[execution runbook](production-test-account-execution.md) for current commands
and [implementation results](../production-test-rollout-implementation-results.md)
for actual verification status. References below to missing tooling describe the
original planning baseline, not authorization to run it. No live execution or
successful real-database rehearsal is implied by this update.

Status: **owner-authorization change proposed for review; execution not authorized**. No production connection, account inspection, bootstrap, password initialization, HTTP test, migration, push, merge, workflow dispatch or deployment has occurred. Commercial launch status does not change the production security boundary.

Use the [review-only inventory](../production-test-account-inventory.json), [existing bootstrap procedure](platform-owner-bootstrap.md), [ADR 0014](../adr/0014-first-platform-owner-bootstrap.md), [deployment procedure](production-deployment.md) and [role matrix](../qa-role-permission-matrix.md). The matrix's permission grants remain authoritative; its `.invalid` usernames belong to local tests and are not this rollout's identities.

## Scope and decisions for review

Keep `NODE_ENV=production`, HTTPS validation, Secure/HttpOnly session cookies, SameSite, CSRF, current terms, rate limits, lockout, database permissions, audit retention and internal admin access restrictions unchanged. Do not introduce a public seed endpoint, startup/deploy seed hook, email bypass in authentication, weak-password exception, shared password or production-mode switch in the completed local seeder.

Prepare eleven dedicated fictional `@truevoice.com` identities: five organization roles in new `truevoice-testing` and six platform roles with no tenant membership. The first Platform Owner is created exclusively through the existing immutable bootstrap. A separate production executor now implements the other ten; use the execution runbook. Its existence does not authorize production execution. The completed `test-accounts:*` and `qa:provision` commands remain isolated-test-only and must not be edited, dependency-injected, renamed or relabeled to run on production.

`admin@truevoice.com` remains an additional preserved account, outside these eleven. This matches the prior eleven dedicated-role inventory plus the existing QA Owner. Do not silently substitute it for `qa-owner@truevoice.com`, move it from its existing organization, attach it to `truevoice-testing`, or test unknown passwords against it. If the reviewer instead wants exactly eleven total identities including this account, stop for an explicit revised inventory and membership authorization before implementing or executing that variant.

These are fictional login identifiers, not proof of control over mailboxes. Before execution, the owner must confirm control of `truevoice.com` and reserve these identifiers against real-user collisions. Never send invitation or reset-request emails to them. Do not weaken production email settings globally. Users will sign in directly with privately configured passwords after authorized initialization; no email delivery or tester-facing activation link is needed.

## Explicit approvals and stop gates

| Gate | Required concrete owner decision or evidence | Must be complete before |
| --- | --- | --- |
| A — scope | Owner-signed procedure version, eleven emails/roles, separate preserved admin policy, test-only fixture boundaries, credential custodian and retention deadline | Production executor release |
| B — implementation | Production executor, protected credential reader, HTTP initializer/verifier, disable path, exact signature schema, append-only provenance, concurrency/rollback tests and isolated Linux/PostgreSQL/HTTPS rehearsal evidence | Owner signs a bootstrap/provision action |
| C — schema/release | Exact immutable release SHA, migration set/ledger, backup/restore evidence, rollback plan and successful protected CI/deployment status | Owner signs a production action |
| D — bootstrap | Exact new owner email, stable operation UUID, owner signature, approved release, database host/port/name/system identifier, HTTPS origin, expiry and `productionAuthorized: true` | First-owner bootstrap invocation |
| E — remaining accounts | Exact ten identities, private credential-file reference (never contents), approved owner/grantor ID, database fingerprint, operation IDs, expiry, no-conflict findings and direct-password authorization | Production executor invocation |
| F — HTTP tests | Exact eleven users, synthetic organization/fixture IDs, owner-signed endpoints/actions, controlled negative login attempts, rate-limit pacing and evidence redaction | Actual sign-ins and authorization probes |
| G — retirement | Exact managed user/fixture IDs, time window, session/support-access revocation, owner retirement/recovery decision, recovery custodian and retention rules | Disable/cleanup |

The owner-signature procedure makes the project owner's decision auditable and does not represent independent security review. An unsigned approval or JSON authorization flag has no authority. Execution stops on unknown or failed checks. Do not infer a deployed database state from source, old snapshots, schema files, user-reported account status or previous fake-backed tests.

## Authorized read-only production preflight — not performed

After approval for inspection, record the active release SHA, effective production environment, exact database endpoint and name, existing database role/grants, PostgreSQL system identifier and migration ledger using established trusted read-only tooling. Never print environment files, connection strings, full process environments or credential hashes. `pg_control_system()` access must already be authorized; do not grant rights to make a check pass. Independently confirm routing and cluster inventory: a physical clone can share a system identifier.

Inspect only projected user IDs/status, membership organization IDs/roles, platform assignment role/revocation and immutable bootstrap operation/claim/audit IDs. Check every candidate email case-insensitively, `truevoice-testing` slug/name, all historical Platform Owner assignments including revoked/pending entries, and the fixed bootstrap slot. Verify backup freshness and proven recovery; do not perform an ad-hoc backup/restore experiment against production.

Conflict decisions:

- `admin@truevoice.com` exists and matches the expected historical organization OWNER: record its current non-credential metadata and preserve it. Unexpected scope, platform assignment or status: stop and seek an account-specific decision. No automatic recovery/reset is authorized.
- Any candidate email exists without this operation's verified immutable provisioning provenance: stop. An identical role is not consent to adopt the user or replace its password. A different email requires revised approval; do not improvise suffixes.
- A committed candidate from the same approved operation exists: reconcile its exact ID, role, organization, credential-verification outcome and audit IDs; report unchanged. A password mismatch stops; no rotation or silent repair.
- `truevoice-testing` exists without verified rollout ownership/provenance: stop; never repurpose or erase it. Extra memberships, unexpected tenant data, suspension or role combinations also stop.
- Any first-owner claim or historical owner assignment exists: **do not bootstrap**. Reconcile and use an existing owner only under a separately scoped owner authorization. An existing owner under a different email blocks the proposed first-owner inventory; revise it or use separately reviewed recovery, never manufacture a second first owner.

## Release and deployment plan

Preserve all current uncommitted work. Review the implemented production executor and protected HTTP tooling and complete its isolated rehearsal, without relaxing local seeder guards. Pin the final release and package scripts; do not install an ad-hoc script in the live release or run source from this dirty feature worktree against production.

Run local focused tests, lint, typecheck, full tests and builds first, then isolated Linux/PostgreSQL/HTTPS integration tests: real claim integrity, concurrent conflicting operations, failed audit/last-write rollback, connected fingerprint mismatch, secret-safe diagnostics, direct password authentication, scope denial and disable. Existing inability to run Docker/WSL locally is a blocker to this evidence, not permission to rehearse on production. Use one deliberate hosted/approved isolated rehearsal if needed; no repeated Actions dispatches or production credentials in CI.

Only after release approval, explicitly authorize the commit/push/PR/merge steps. Existing `.github/workflows/deploy.yml` requires a successful main-push CI run for the exact current main SHA, `DEPLOYMENT_READY`, manual `workflow_dispatch` with `authorize_production=true`, and the protected production environment. Preserve all those checks. Deployment is code/schema delivery, not account-creation authorization. Account configuration and credentials never enter Actions.

Review actual `infrastructure/migrations-reviewed.json` and deployed ledger together. The checked-in manifest currently lists the three bootstrap migrations, despite historical bootstrap documentation describing them as absent. A manifest entry is not evidence of live application or current approval. `deploy.mjs` calls the controlled migration path during release activation; do not run a second manual migrate command or edit an applied migration. Resolve documentation/ledger/approval disagreement before deployment, rather than bypassing the gate.

## First Platform Owner initialization

Use the existing bootstrap implementation unchanged from the approved deployed release. The action-specific owner signature must name `qa-platform-owner@truevoice.com`, production origin, exact database hostname/port/name and verified `database.systemIdentifier`, a stable operation UUID, operator/approval references, and expiry no more than 24 hours away. Set `productionAuthorized: true` only in the exact draft that the owner signs. The command verifies the connected database and fingerprint and writes user, role, immutable singleton claim and linked audit atomically. It refuses every prior owner/claim and existing email.

Prepare separate private Linux approval, credential and activation directories outside all checkouts, release trees, web roots, CI, backup/sync collection and shared folders. Operator/recipient ownership, 0700 directories, 0600 regular files, safe ancestors, no symlinks/hard links and `/proc/self/fd` requirements apply. Privately load the established production environment; never print or change its values. The following is the **existing command shape, not authorization to run it**:

```sh
PLATFORM_OWNER_BOOTSTRAP_ENABLED=1 npm run bootstrap:platform-owner -- \
  --environment production \
  --email qa-platform-owner@truevoice.com \
  --operation-id '<approved-stable-uuid>' \
  --approval-file '/absolute/private/approval.json' \
  --activation-directory '/absolute/private/activation' \
  --confirm-production
```

Keep existing `NODE_ENV=production` and `WEB_PUBLIC_URL=https://voice.truevinecloud.online`; do not place DATABASE_URL in the command. Reconcile the committed operation, claim and audit before using its artifact. The bootstrap artifact currently expires in 24 hours; do not confuse this with the shared one-hour recovery-token default. No raw activation URL/token is reported or requested through email.

The named test-account custodian chooses the owner's unique password in the protected credential configuration. Through a **reviewed private HTTP client**, read only that operation's activation token into memory from its protected artifact and submit it with `newPassword` to `POST /api/auth/password-reset/complete` over the verified production HTTPS origin, with valid `tv_csrf` cookie and matching `x-truevine-csrf` header. Do not navigate to the token-bearing URL, put it in a query/log, call password-reset/request, or send a link to the tester. This uses the existing one-use completion transaction; it does not create a second bootstrap or write a password hash directly to an existing owner. The actual custodian controls and submits the password; independent operator access is not implied.

This changes the delivery method for synthetic test custodians from the existing recipient-link runbook and needs explicit Gate D acceptance plus rehearsal of the private client. The client is implemented by the initialize action in the execution runbook and still requires isolated rehearsal and production authorization. Once complete, verify the password-reset audit, consumed token, immutable claim, revoked prior sessions and real HTTP sign-in. Retire the private activation artifact after reconciliation. Expired/lost artifacts or unknown commit outcomes require separate recovery; do not regenerate another owner, claim or token blindly.

## Remaining ten accounts and private credential contract

The proposed production executor must accept only a private configuration path, not password arguments, environment passwords, plaintext samples, shell heredocs, logs or CI uploads. Configuration contains version, stable operation IDs, approval reference, approved release/fingerprint/origin, exact email/scope/role inventory, credential custodian and distinct privately supplied passwords. Each password must pass the existing nonblank 12–200 character policy and existing Argon2id hashing; no emailed activation is needed for these newly created users. No real password or executable authorization template is committed in this review package.

Before any write, verify production opt-in plus a valid action-specific owner signature, approval expiry, exact target/cluster identity, authenticated approving Platform Owner, singleton claim and all conflicts. Acquire durable transaction serialization and database uniqueness fencing for the operation. Bind account operation provenance to immutable audit IDs so retries and cleanup cannot adopt unrelated users. Preflight the whole ten-account batch, then create the new organization, five tenant-scoped memberships and five platform-only assignments with proper grantor/audit metadata in one transaction. No platform user gets an implicit customer membership. Never write an existing user's password/role/status automatically. Audit creation must fail the whole batch on failure; every status returned must follow confirmed commit.

Reruns verify rather than repair. Ambiguous commit/network/disconnect errors fail with a fixed secret-free message; preserve protected inputs, reconcile by operation IDs, and retry only after the outcome is known. No in-memory/Redis-only idempotency, artificial claim rows, direct SQL fixes or new bootstrap path is permitted. The implementation selects an append-only completed-batch identity audit whose primary key is the stable provision UUID, combined with serializable preflight, advisory locking and existing uniqueness. Its real database rehearsal remains required.

The production inventory deliberately differs from the completed `.invalid` local seeder. No current command accepts this production manifest. Executable provision/verify/disable actions now exist; owner authorization is specific to each action. Do not substitute a staging/local command or change NODE_ENV/database names to defeat its refusal.

## Actual HTTP and interface acceptance — execute only after Gate F

Use [the separate HTTP acceptance checklist](production-test-account-http-checklist.md). Every one of the eleven must produce correct-password, incorrect-password, identity/role, authorization and logout evidence over actual HTTPS. A stored hash match, local AuthService fake, inferred role or successful migration cannot count as a live sign-in. Do not claim full permitted functionality when an endpoint/dashboard is absent.

## Cleanup and rollback

Gate G must approve an expiry date and exact managed IDs before account creation. The production disable executor (implemented; review/rehearsal and execution approval pending) must bind to the same cluster/release/approval and immutable operation provenance; suspend only managed rollout accounts, revoke all sessions/support-access sessions, expire outstanding reset tokens, record append-only audit, and prove sign-ins and previously issued sessions are denied. Repeat safely without changing passwords or unrelated users. Never delete audit, claim, ledger or historical role/membership records to clean up.

Disable the remaining ten first. Treat Platform Owner retirement as a **separate explicit decision**: suspension must not delete/reset the bootstrap slot or permit re-bootstrap. Confirm a separately authorized administration/recovery custodian before retiring the only owner. `admin@truevoice.com` is never a cleanup target. Missing or changed provenance/role/tenant checks stop cleanup rather than broaden it. Destroy private credential shares/files using the approved retirement policy after disable evidence and retention requirements are met.

On application regression use the existing reviewed release rollback procedure after its own approval; retain the database and all committed users/claims/audits. Rollback of code is not rollback of identities, migrations or passwords. A definite uncommitted transaction rolls back normally. An ambiguous outcome is reconciled read-only; do not reset the database, drop constraints or restore old credentials to retry. Unauthorized access/exposure invokes the existing incident process and separately approved revocation/recovery, not a hurried re-bootstrap.

## Readiness verdict

Procedure and inventory: prepared for review. Production executor/private HTTP client: implemented; see execution runbook and current results. Isolated real-database/Linux rehearsal: required CI evidence pending. Live read-only preflight, release, bootstrap, ten-account provisioning, HTTP acceptance, cleanup: **not run and not authorized**. This branch proposes the owner-signature policy; production execution remains unauthorized until CI passes, the PR completes the repository's review process, the policy is deployed through the protected workflow, the root-pinned public key is installed, and separate action signatures are supplied. The signature is owner authorization, not independent security review.
