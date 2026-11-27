# Existing local QA platform account recovery

This Windows-only operator tool supports exactly these existing identities:

| Email | Immutable expected ID | Required active platform role |
| --- | --- | --- |
| qa-platform-owner@truevoice.com | 918d4f57-f901-459e-b522-71a9165cffe2 | PLATFORM_OWNER |
| qa-support-admin@truevoice.com | c53c116b-8f77-4af4-b8af-281bcc9219e5 | SUPPORT_ADMIN |

It refuses other identities, missing/suspended users and revoked/changed roles.
There are no email, ID or role override arguments. It never creates users,
changes role assignments or bypasses password policy. This procedure is local
operator recovery, not a production tool, public endpoint or new authentication
architecture. It follows ADR 0010 and the existing operator reset-token issuance
pattern. No schema change or dependency installation is required.

## Approval boundary

Implementation and fake tests do not authorize live use. Obtain explicit approval
for **both** issuance and completion against the named QA database before running
the commands below. Each mutation command requires the explicit approval flag;
an environment variable alone cannot authorize a recovery. The operation UUID
ties both account issuance audits to one encrypted bundle. Do not run these
commands as part of setup, tests, CI or application startup.

## Storage and prerequisites

Windows PowerShell 5.1 and .NET's DPAPI `CurrentUser` protect the bundle at:

`%LOCALAPPDATA%\TruevineVoice-QA-Recovery\<operation-uuid>.dpapi`

The helper creates the directory with a protected ACL allowing only the current
Windows SID. It rejects existing shared/foreign-owned directories/files and
reparse-point ancestors. DPAPI binds decryption to the same Windows user/machine.
The bundle contains two different random 256-bit passwords, reset capabilities,
IDs and expiry. Plaintext is held in process memory and anonymous child-process
pipes only. It is never a command argument, terminal output, log or repository
file. The helper refuses storage beneath this checkout. Do not redirect its
private `read` action to the terminal; it is an internal pipe protocol consumed
by the Node command. Run both commands as the same Windows user.

No plaintext password display/retrieval command is provided. A subsequent
approved API/UI verification can read credentials privately through the helper's
pipe protocol. Do not copy passwords into chat or introduce a plaintext export.
Keep the encrypted bundle until verification and any partial-state reconciliation
are finished; retention/deletion is a separate operator decision.

`DATABASE_URL` must be explicitly supplied through the private process environment.
It must use PostgreSQL, `localhost` or `127.0.0.1`, port `55432`, and exactly
`truevine_bootstrap_test_a1b2c3d4e5f67890`, without query/fragment options.
`EXPECTED_DATABASE_NAME` must equal that name; `NODE_ENV` must be `development`
or `test`. `REDIS_URL` must point to loopback Redis on port `56379`.
The database server must report the expected database and internal port `5432`.
Do not change `.env` (which points at the development database), paste a connection
URL into a command or reuse a remote/production credential. Supply the already
approved local QA connection through your private environment loader.

The completion command uses the built application's exported `AuthService`,
resolved by the existing Nest testing harness with a pinned, log-disabled Prisma
client. It opens no HTTP listener. Its database transactions recheck both exact
identities and roles under user/role row locks before invoking application stores.
This avoids routing a credential write through an unverified running API.
Email transport is disabled in this one process, and Redis must be local.

## Exact commands after live approval

Prepare the non-secret environment below **after privately supplying DATABASE_URL**:

```powershell
$env:NODE_ENV = 'development'
$env:EXPECTED_DATABASE_NAME = 'truevine_bootstrap_test_a1b2c3d4e5f67890'
$env:REDIS_URL = 'redis://127.0.0.1:56379'
$env:WEB_PUBLIC_URL = 'http://localhost:3000'
$operation = [guid]::NewGuid().ToString()
npm.cmd run build:packages
npm.cmd run build:api
npm.cmd run qa:recover-platform -- issue --approve-local-qa-recovery --operation-id $operation
npm.cmd run qa:recover-platform -- complete --approve-local-qa-recovery --operation-id $operation
```

No live commands have been authorized by the implementation task. The UUID is
not a secret; retain it with the printed encrypted bundle location. Tokens use
the existing `PASSWORD_RESET_TTL_MS` (currently one hour), so complete promptly.

### Expected database effects

`issue` locks and validates both existing users and role assignments. Within one
transaction it expires each user's prior unused reset tokens, creates exactly
one new hashed reset token per user with the existing TTL, and appends exactly
two `auth.password_reset_requested` identity audits. Metadata contains source,
operation UUID, target user ID and OS operator reference, never secrets.
It writes the DPAPI-encrypted bundle before committing; vault/audit failure
aborts the transaction. Issuance does **not** change passwords or sessions.

`complete` checks bundle identity, target, expiry, password policy, issuance
audits and both unused token rows before completing either account. Each
`AuthService.completePasswordReset` call enforces the normal password policy and
atomically consumes its token, replaces the password through application stores,
invalidates other reset tokens, revokes existing sessions and appends
`auth.password_reset_completed`. The two completions are separate application
transactions: a later failure can leave the first account completed. Original
IDs, roles, memberships and historical audit rows remain unchanged.

### Failure and retry policy

Never automatically retry or overwrite a bundle. Issuance rejects an operation
already present in the audit trail; exclusive bundle creation also fences UUID
reuse. If storage succeeded but DB commit failed or the result is uncertain,
retain the encrypted artifact and reconcile the operation's audits/token state
read-only before a separately approved attempt. A failed issuance may leave an
encrypted unusable bundle. Neither output nor exit code alone proves rollback
after a lost database response.

Completion refuses consumed/expired tokens before the first mutation. It does
not automatically reissue, replay, repair or reset both accounts again after a
partial completion. Reconcile which completion audit committed, then obtain
approval for any follow-up recovery. Generic CLI failures deliberately withhold
exception details because driver/runtime errors may contain sensitive arguments.

### Verification after recovery (separate approved execution)

Use the private bundle through a memory-only consumer to sign in through the
QA-targeted API. Verify returned IDs and platform roles, repeat authenticated
reads with the same cookie jar to establish session persistence, then sign out.
Check Owner access to operations/support/technical and Support Admin access to
support with operations/technical denied. Do not probe paid operations or accept
terms automatically. First attest the running API's database configuration; no
verification write may reach `truevine_voice`.

If browser access is available, repeat at `http://localhost:3004/admin` and
`http://localhost:3004/admin/support`, including reload/session persistence.
An unavailable browser host is a reported limitation, not a browser pass.

## Offline checks

```powershell
npm.cmd run lint:qa-platform-recovery
npm.cmd run test:qa-platform-recovery
npm.cmd run test:qa-platform-vault
npm.cmd run lint
npm.cmd run typecheck
npm.cmd test
npm.cmd run build
```

Focused tests use only fake transactions, a fake vault and a fake completion
service. They cover approval and database guards, exact identities/roles,
two audited capabilities, policy-valid distinct passwords, audit/vault failures,
reused operations, bundle/proof rejection and completion delegation. They do not
prove live SQL or a live recovery. The separate vault self-test performs a
synthetic DPAPI encrypt/decrypt roundtrip in memory only, without writing files
or connecting to a database. It requires access to the current Windows profile;
a sandbox without that profile may need approval for this test alone. That test
approval does not authorize live recovery. The helper runs trusted repository
source as an inline PowerShell command without changing execution policy.
