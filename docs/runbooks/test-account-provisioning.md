# Test-account provisioning for development and staging

How to create **Owner**, **Organization Admin** and restricted-member
(CAMPAIGN_MANAGER / VIEWER) accounts for login and authorization testing, using
only the flows the product already has — with no hardcoded passwords, no seeded
credentials and nothing written into production.

> **Development and staging only.** Never run these steps against production
> without explicit, separately-issued approval (AGENTS.md §11, §15).
> `provision:owner` refuses a production-looking environment unless it is given
> `--confirm-production`; do not pass that flag to make a failure go away.

---

## 1. What exists (audit summary)

There is deliberately **no public registration**. Every account enters the
system through one of two paths:

| Path                                                                     | Creates                                                                             |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| `npm run provision:owner` (`infrastructure/scripts/provision-owner.mjs`) | a user **+** an organization **+** its first `OWNER` membership, in one transaction |
| `POST /invitations/accept` (invited member, signed in)                   | a `Membership` for an **existing** user whose email matches the invitation          |

Consequences that shape the procedure:

- **An invited member must already have an account.** Since there is no
  sign-up, each test identity is first provisioned as the owner of its own
  throwaway organization, activated, and _then_ invited into the target
  organization with the role under test. This is the same pattern
  `infrastructure/scripts/verify-activation-journey.mjs` uses for its ADMIN
  teammate.
- **A provisioned account has no usable password.** The stored hash is the
  Argon2id hash of `randomBytes(32)` (32 random bytes / 256 bits), a value no
  operator or script ever sees — so no usable password exists until a
  **single-use activation token** (24 h) is consumed through
  `POST /auth/password-reset/complete`, the same code path as a
  forgotten-password reset. The token row is a `password_reset_tokens` row; the
  raw token is written to a `0600` file inside a `0700` directory under
  `.owner-activation/` (gitignored), and the CLI prints only that file's path,
  never a password.
- **Invitation tokens exist only in the email.** The database stores only the
  SHA-256 digest. In development, `EMAIL_TRANSPORT=development` writes the
  message — including the raw link — to `EMAIL_CAPTURE_DIRECTORY`
  (`./.email-capture/`, gitignored).
- **Protected organization routes require accepted terms.** Each account must
  `POST /auth/terms/accept` once after signing in before it can call them.
- **`OWNER` is not invitable.** It exists only through
  `POST /organizations/{id}/ownership/transfer`.

## 2. Roles available for test accounts

| Role               | How it is obtained                       | Reach                                                                                              |
| ------------------ | ---------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `OWNER`            | `provision:owner`, or ownership transfer | everything, including `ownership:transfer`, `billing:*`, `wallet:read`                             |
| `ADMIN`            | invited by an Owner                      | organization settings, members, invitations, campaigns (registry-level); **no** ownership or money |
| `CAMPAIGN_MANAGER` | invited by Owner or Admin                | campaign and reporting permissions only                                                            |
| `VIEWER`           | invited by Owner or Admin                | read-only                                                                                          |

An Admin may only invite or grant `CAMPAIGN_MANAGER` and `VIEWER`
(`canDelegate('ADMIN', …)`); `BILLING` and `ADMIN` are Owner-granted.

## 3. Prerequisites

```bash
npm run infra:up          # PostgreSQL + Redis
cp .env.example .env      # once; EMAIL_TRANSPORT=development is the default
npm run prisma:generate   # once per fresh clone
```

Generate a **fresh random passphrase per account** and keep it outside the
repository (password manager or a local environment variable). Never hardcode,
never commit, never print it into a log or a screenshot:

```bash
node -e "console.log(require('node:crypto').randomBytes(24).toString('base64url'))"
```

## 4. Procedure

### Step 1 — Provision and activate the Owner

```bash
npm run provision:owner -- --email owner-<runid>@example.test --organization-slug tv-<runid>
```

1. The CLI prints the path of the single-use activation file (mode `0600`
   under `.owner-activation/`). Read the token from it locally.
2. Activate by setting the first password through the API:

   ```http
   POST /auth/password-reset/complete
   { "token": "<activation-token>", "newPassword": "<generated passphrase>" }
   ```

   (or open the printed `…/set-password?token=…` URL in a private window).

3. Delete the activation file once used.

### Step 2 — Sign the Owner in and accept terms

Sign-in is itself a CSRF-protected `POST`, so the CSRF cookie has to exist
first. It is issued by middleware on **any** request that does not already carry
one, which is why an anonymous `GET` precedes the first sign-in:

```http
GET  /auth/terms                      -> 200, and the middleware sets the tv_csrf cookie
POST /auth/sign-in                    { "email": …, "password": … }   (with x-truevine-csrf)
POST /auth/terms/accept                                            (session + CSRF)
```

The header must echo the `tv_csrf` cookie value. Cookie jar plus header is the
whole contract; there is no separate endpoint that mints the token.

### Step 3 — Provision each Admin / restricted member identity

Repeat the Step 1–2 recipe with a **unique** email and a throwaway slug for
each identity (one org per identity, activated with its own generated
passphrase):

```bash
npm run provision:owner -- --email admin-<runid>@example.test  --organization-slug tv-admin-<runid>
npm run provision:owner -- --email viewer-<runid>@example.test --organization-slug tv-viewer-<runid>
```

These throwaway organizations are inert (one member each) and exist only
because invited members need an account to sign in with. They are a
development convenience, not a product flow.

### Step 4 — Owner invites them into the target organization

```http
POST /organizations/{organizationId}/invitations
{ "email": "admin-<runid>@example.test", "role": "ADMIN" }
```

Repeat with `"role": "VIEWER"` (or `CAMPAIGN_MANAGER`, `BILLING`) for the
restricted members. The raw token is in the captured email:

```bash
# .email-capture/ contains the invitation message
# extract: /accept-invite?token=<raw-token>
```

### Step 5 — Each invitee accepts while signed in

```http
POST /auth/sign-in            (as the invitee, then terms/accept)
POST /invitations/accept      { "token": "<raw-token>" }
```

The signed-in email must match the invitation exactly, or the accept is
refused and audited.

### Step 6 — Verify roles

```http
GET /me                                   -> memberships[] with role + effective permissions
GET /organizations/{organizationId}/members -> every member's role
```

`GET /me` `permissions` is presentation only; the server re-checks every
request.

## 5. Safety rules

- **No hardcoded passwords.** Every credential is a fresh random value kept
  outside the repository. The provisioning CLI never prints one, and no script
  in this procedure writes one into a file that is committed.
- **No production seeding.** Never point `DATABASE_URL` at production for these
  steps; never pass `--confirm-production`.
- **Treat captured links as credentials.** `.email-capture/` messages contain
  raw invitation and reset tokens; both directories are gitignored — keep them
  that way and delete used messages and activation files.
- **Nothing sensitive in logs.** Do not echo passphrases or tokens into shell
  output, CI logs or support tickets; the audit writer refuses credential-shaped
  metadata keys (`password`, `token`, `authorization`, `cookie`, `apikey`,
  `credential`, `dsn`, …) via `isSafeAuditMetadata`, and tests assert it for each
  known writer.
- **Test rows persist.** `security_audit_events` is append-only, so suites use
  unique slugs/emails per run and cannot clean up their audit history. Use
  `npm run db:reset` for a clean development slate; never against a database
  you did not create.
- **Revocation works.** `POST /auth/password-reset/complete` and
  `POST /auth/sign-out` revoke sessions; use them when retiring a test account.

## 6. Relationship to the verification scripts

| Script                      | Accounts                                                                                                                                |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run verify:journey`    | provisions its own disposable Owner + teammate end to end, including activation                                                         |
| `npm run verify:boundaries` | provisions two independent tenants automatically                                                                                        |
| `npm run verify:frontend`   | requires **`OWNER_EMAIL` / `OWNER_PASSWORD`** for a provisioned development Owner; missing credentials fail loudly rather than skipping |

For `verify:frontend`, supply a Step 1–2 Owner's address and its generated
passphrase through the environment (a local `.env` or the shell session) — not
as literals in any file.

Actual interactive login testing of the Organization Admin permission matrix
remains pending until at least one Owner and one Admin account have been
provisioned with this procedure.
