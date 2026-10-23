# Executable production test-account workflow

Status: implemented locally, **not authorized or executed on production**. Real PostgreSQL rehearsal remains blocked in this session. Preserve production environment/security settings and use the existing CI/CD workflow for code delivery. Never run a feature checkout or copied script against production.

## Commands and private inputs

The root entry point is `npm run rollout:test-accounts -- <action> ...`.

- `inventory`: prints the exact eleven fictional `@truevoice.com` accounts and the current inventory digest. Contains no credentials and needs no opt-in.
- `template`: prints an **invalid/unapproved blank** approval/credential shape. All secret values are null. Use a private editor/password manager to separate the `approval` and `credentials` objects into protected files and populate them; do not put real secrets in stdout, shell arguments, env variables, heredocs, CI, source or Git.
- `bootstrap`: delegates to the existing first-owner bootstrap, with all its original checks. Needs both opt-in flags, approval/credentials paths and a private activation directory.
- `initialize`: privately consumes that bootstrap artifact through the actual CSRF-protected password completion endpoint. It verifies the claim/audit/token owner/hash first, requires the correct deployed HTTP health version/environment, and verifies the consumed token and configured password afterward. No email, link delivery, query-string secret or direct replacement of an existing unrelated password.
- `provision`: creates the other ten identities plus `truevoice-testing` and an empty `truevoice-testing-isolation` tenant. Both names must be unused unless already bound to the same durable operation. The five platform operators have no customer memberships. The five customer users have exactly one test-tenant membership. Records each creation and the completed batch in append-only identity audit.
- `verify`: checks the actual cluster, preserved admin, approved bootstrap owner, batch provenance, all credential hashes/statuses and exact scopes, without changing credentials/roles.
- `http`: performs native HTTP sign-ins, wrong-password rejection, role/organization permission checks, ten representative allowed/denied read probes per account, tenant isolation and stale-session rejection after logout. Does not fabricate terms acceptance or exercise paid/privileged mutations. Emits only non-secret final outcomes after every identity passes; failures are fixed diagnostics, never raw errors or partial success claims.
- `disable`: suspends only the ten batch-owned accounts, revokes authentication sessions, expires unused reset tokens, revokes support rows within the two approved fixture tenants and records a durable disable audit. Authentication-session revocation also invalidates support access elsewhere without editing other tenants. Preserves `admin@truevoice.com`, the bootstrap owner, all passwords, assignments, immutable claim, tenant records and audit history. Repeats safely. No automatic reactivation or delete/reset command exists.

Every executable action requires `--approval /absolute/private/approval.json --credentials /absolute/private/credentials.json`. Production also requires `--confirm-production`. Only `bootstrap` additionally uses `--activation-directory /absolute/private/activation`; only `initialize` uses `--artifact /absolute/private/activation/platform-owner-<bootstrap-operation>.json`. Do not pass a password or token as an argument. Unknown/duplicate options and action mismatch refuse.

Use Linux, an operator-owned private local filesystem outside every release/checkout/web root/sync/backup/log collection location, 0700 directories, 0600 regular files, safe ancestors, no symlinks/hard links and trusted operator UID. The existing pinned-descriptor private reader enforces the same contract as bootstrap. Do not weaken those checks to run on Windows. The server's existing production configuration is loaded through the established private operator mechanism; these commands never load ambient .env files themselves.

## Approval contract — no defaults grant authority

`template` describes exact required keys. Independently reviewed approval must contain:

- version 1; one exact action; environment `production`; `productionAuthorized:true`; the exact current approved `releaseSha`; and `provisioningReleaseSha` identifying the initial batch release. On provision these SHAs must be equal. Later verify/http/disable can use a newer approved active tool release while binding to the original batch release.
- the printed current `inventoryDigest`; owner email exactly `qa-platform-owner@truevoice.com`; `operationId`, `bootstrapOperationId`, `provisionOperationId` as stable UUIDs; distinct independent request/operator/credential/rehearsal references (uppercase letters/digits/underscore/hyphen, 3–64 characters); a UTC expiry in the next 24 hours at most.
- exact database hostname, port as a string, database name and independently verified decimal `systemIdentifier`. The connection URL is supplied privately as DATABASE_URL, never in JSON examples/arguments/output. Only public-schema/SSL URL settings are allowed, not host redirection or arbitrary options. The connected database and `pg_control_system()` fingerprint are checked before every transaction; no permissions are granted to make this work. A physical clone may share the fingerprint, so independently verify routing/inventory.
- `applicationOrigin` exactly `https://voice.truevinecloud.online`, matching existing WEB_PUBLIC_URL; production TLS verification cannot be disabled. Existing NODE_ENV must remain production. Private operator process APP_VERSION must equal the approved SHA. The code itself must reside in `/var/www/TruevineVoice/current` with matching deployed `REVISION` and `READY` markers; changing APP_VERSION cannot enable a dirty checkout or stale release.
- after bootstrap, `actorUserId` exactly the new claimed owner UUID. `preservedAdmin.userId` and `preservedAdmin.organizationId` must come from separately approved read-only inventory of `admin@truevoice.com`. The executor requires its existing ACTIVE, sole OWNER membership and no platform assignment; it selects no password for that account and never updates it. An unexpected state or missing identity blocks execution.
- for `initialize` or `http`, `httpAuthorized:true` in that action's independent approval. Bootstrap additionally requires the original `PLATFORM_OWNER_BOOTSTRAP_ENABLED=1`; normal execution uses `TEST_ACCOUNT_ROLLOUT_ENABLED=1`. Keep both unset by default and remove process opt-ins after execution.

The private credential file has version 1, `reference` matching `credentialReference`, and `passwords` with exactly the eleven inventory emails. Custodians choose distinct nonblank 12–200 character passwords. No defaults, generated passwords or shared password are committed. New accounts use the existing Argon2id parameters. Existing accounts with missing provenance, different scope/status/password, or a different operation are **conflicts**, not repair targets. A field in JSON is not independent human approval; the executing operator verifies the signed-off record separately, as with existing bootstrap.

## Exact staged execution after independent authorization

1. Complete the isolated rehearsal described below and the [rollout approvals](production-test-account-rollout.md). Review source, real database/HTTP evidence, schema manifest/ledger, backup/recovery and release. Obtain explicit commit/push/PR/merge authorization. The branch remains uncommitted/unpushed from this task.
2. Deliver code through the existing main CI and human-authorized production workflow. It must be the current tested main SHA and pass existing deployment/migration gates. No workflow was changed. Account creation is not a deploy hook or Actions step; no credential file goes to GitHub.
3. Independently authorize live read-only preflight: current release, production cluster identity, admin's non-secret scope, all eleven candidate email conflicts, both tenant slugs, any historical Platform Owner assignment and bootstrap claim. Confirm a protected HTTPS admin interface and private logs/client handling. Stop on any discrepancy. Reserve the fictional addresses against actual users; send no mail to them.
4. Prepare private credentials and an approved bootstrap action record. Pick a stable bootstrap UUID and provision UUID **before** bootstrap. For this stage set operationId=bootstrapOperationId, and actorUserId may be null because it does not exist yet. The original bootstrap checks all previous owner assignments/claims and refuses them, even revoked/historical. Existing owner/claim requires reconciliation/revised authorization, never a second bootstrap.

   ```sh
   npm run rollout:test-accounts -- bootstrap \
     --approval /absolute/private/bootstrap-approval.json \
     --credentials /absolute/private/credentials.json \
     --activation-directory /absolute/private/activation \
     --confirm-production
   ```

   Execute only in the approved active release, with privately loaded original production settings and the two explicitly enabled opt-ins. Result contains only operation/owner IDs, expiry and artifact path. Reconcile the claim and linked audit before continuing. No secrets appear in that output.

5. Prepare separately approved initialize action record with a new operation UUID, the original bootstrap/provision UUIDs, actual owner ID and `httpAuthorized:true`. The artifact is still private and one-use. Initial bootstrap artifact expiry is 24 hours; the generic recovery default is one hour. The custodian authorizes this initial password, and the existing HTTP completion flow performs the audited change.

   ```sh
   npm run rollout:test-accounts -- initialize \
     --approval /absolute/private/initialize-approval.json \
     --credentials /absolute/private/credentials.json \
     --artifact /absolute/private/activation/platform-owner-<bootstrap-operation>.json \
     --confirm-production
   ```

   Replace the path placeholder privately. No token-bearing URL is opened or logged. A lost response is reconciled against used token + matching password before an idempotent retry. A used token with a different password, an expired unused token, an unrelated token/user or changed claim refuses. Lost/expired artifact recovery needs a new independent recovery decision, not re-bootstrap.

6. Prepare a provision action approval with operationId=provisionOperationId, the same actor/bootstrap UUIDs, original provisioning SHA, current release SHA and exact private credential reference. Run:

   ```sh
   npm run rollout:test-accounts -- provision \
     --approval /absolute/private/provision-approval.json \
     --credentials /absolute/private/credentials.json --confirm-production
   ```

   A fixed PostgreSQL advisory lock, serializable transaction, existing unique email/slug constraints and append-only audit primary key equal to the provision UUID fence concurrent operations. Ten users and both synthetic tenants commit with audit or all roll back. Any email/slug collision without this exact batch provenance refuses. `admin@truevoice.com` stays separate. Reuse the same operation on retry after reconciliation; never mint a different operation to bypass a refusal.

7. Issue a fresh verify action approval, new operation UUID, same provision/bootstrap UUIDs and original provisioning SHA. Run the same command shape with action `verify` and its approval path. This is credential/database verification, not evidence of HTTP or browser success.
8. Custodians sign in normally at `https://voice.truevinecloud.online/sign-in` and personally accept the current terms if prompted. Customer accounts select `truevoice-testing` under `/app`; platform accounts have no tenant membership and use the existing protected admin interface. Do not expose admin publicly, alter cookies/TLS, fabricate terms consent or use emails/activation links. If terms have not been accepted, HTTP authorization verification stops.
9. Under a separate HTTP action approval run the same command shape with action `http` and its approval path. It first checks actual `/api/health` version/environment before sending credentials, then verifies every identity with independent private jars. Production requests are paced at least one second apart, but actual 429/lockout/terms failures still stop; do not weaken controls or brute-force retries. It prints final non-secret per-account pass/denial outcomes only after all checks succeed. Read-only probes cover organization/profile/members/campaigns/reports/wallet/billing and operations/support/technical/audit contexts, plus a foreign synthetic tenant. Password-policy authentication checks do not assert nonexistent features or privileged mutation coverage.
10. Record actual safe HTTP evidence separately from earlier local tests. The verifier deliberately reports `mutationCoverage:not-exercised`; run only separately approved synthetic mutation/browser checks from the [acceptance checklist](production-test-account-http-checklist.md). BILLING_ADMIN has no implemented billing endpoint/dashboard, so do not label its permitted billing functionality working merely because login and denial checks pass.
11. Retire tokens/jars/private shares after confirmed initialization/verification under the approved retention policy. Keep the private credential configuration available only to authorized custodians until approved disable/recovery; never attach it to a review or report.

## Disable, rollback and uncertain outcomes

Prepare a separately authorized disable approval with a new stable operation UUID, same provision/bootstrap IDs, original provisioning SHA and the current active tool release SHA. Use action `disable` with its private approval/credential paths and `--confirm-production`. Ten accounts become SUSPENDED; passwords/assignments remain; sessions/reset tokens and fixture support sessions are invalidated. A durable disable audit makes repeating the same operation safe. The two existing owners remain ACTIVE and unchanged. Verify disabled sign-ins and stale sessions through separately approved manual/HTTP checks. The general `http` action requires active accounts and will refuse a disabled batch; its refusal is not a complete post-disable acceptance report.

Retiring the only Platform Owner needs a separate approved lifecycle/recovery-custodian procedure; this command cannot disable/delete/re-bootstrap it. Never delete the bootstrap singleton/audit, restore an old password, remove constraints, update production rows manually or reset the database to undo this rollout. Code rollback uses the existing release workflow and preserves identity/audit/schema state. Reconcile any timeout/unknown COMMIT/disconnect failure read-only using the stable audit/claim IDs before retrying. Failures emit a fixed message rather than raw ORM, JSON parse, request/body, connection or credential details.

## Isolated integration command

`npm run test:production-rollout` runs fake-backed safety/protocol tests with real Argon2id. `npm run test:production-rollout:e2e` runs the new real Prisma/PostgreSQL + native HTTP suite. For a trusted disposable loopback PostgreSQL instance, privately supply `ROLLOUT_TEST_ADMIN_URL` pointing only to its `/postgres` database, set `NODE_ENV=test` and `ROLLOUT_E2E_DISPOSABLE=1`, then invoke the root integration command. It fails loudly without those prerequisites. Do not use production credentials or a tunnel.

The suite creates a uniquely named `truevine_bootstrap_test_<16hex>` database, applies migrations only there, creates a synthetic preserved admin, boots Nest with real Prisma stores, delegates immutable bootstrap, initializes over real HTTP, injects a final-audit failure to assert real transaction rollback, tests concurrent first provisioning/reruns and conflicts, obtains actual HTTP terms acceptance for synthetic test custodians, runs all eleven HTTP verifications and disables/checks a stale session. Only the exact database created by that run can be dropped. The existing CI disposable fixture is recognized using the same strict CI/loopback/port/database pattern as the existing bootstrap E2E; no workflow modification or production secret is needed.

Only in opted-in **test** mode may the native client use loopback HTTP for this fixture. Production remains exact-origin HTTPS with normal certificate verification. The suite uses an explicit fixture-only permissive rate limiter and fake Redis lifecycle because the unchanged limiter/Redis contracts have their own tests. It does not establish real production rate-limit operation, Linux protected-file behavior, browser rendering, or production TLS routing. Run the existing bootstrap Linux/file tests and a trusted isolated HTTPS rehearsal before production approval. This session's real database suite failed infrastructure preflight, so **none of this integration execution is claimed passed yet**.
