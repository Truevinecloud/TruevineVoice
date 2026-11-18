# Local QA sign-in for the existing platform accounts

How to sign in, reliably and repeatably, as the two existing local QA accounts:

| Email | Expected immutable ID | Platform role |
| --- | --- | --- |
| `qa-platform-owner@truevoice.com` | `918d4f57-f901-459e-b522-71a9165cffe2` | `PLATFORM_OWNER` |
| `qa-support-admin@truevoice.com` | `c53c116b-8f77-4af4-b8af-281bcc9219e5` | `SUPPORT_ADMIN` |

This runbook covers the local QA environment only. It does not create accounts,
change roles, or replace credentials. Recovering a lost password is a separate,
explicitly approved procedure: see
[Local QA platform account recovery](./local-qa-platform-recovery.md).

## Why local sign-in used to fail

A `401 invalid_credentials` in the QA environment is almost never a wrong
password. Three separate faults produce the same symptom, and all three have
been observed here:

1. **The API served the wrong database.** `.env` points `DATABASE_URL` at the
   development database `truevine_voice`. The QA accounts live only in
   `truevine_bootstrap_test_a1b2c3d4e5f67890`. A plain `npm run dev:api`
   therefore answers `invalid_credentials` for an account that does not exist in
   the database it is actually reading.
2. **The cookie was `Secure` over plain HTTP.** With `NODE_ENV=test` the session
   cookie carried `Secure`, which a browser silently discards on `http://`.
   Sign-in returned 200, the next request returned 401.
3. **The browser changed host.** Cookies are scoped to the host, not the port.
   `localhost` and `127.0.0.1` never share a session, so opening the admin app on
   a different host than the one that signed in loses the cookie.

The API now refuses to boot when the selected database is not the expected one,
and the boot log states the database name, so fault 1 is visible instead of
silent.

## Fixed facts

| Item | Value |
| --- | --- |
| QA database | `truevine_bootstrap_test_a1b2c3d4e5f67890` |
| Development database (wrong for QA) | `truevine_voice` |
| API | `http://127.0.0.1:3001` |
| Customer web app | `http://localhost:3000` (sign-in lives at `/sign-in`) |
| Admin app | `http://localhost:3002/admin` (port is configurable; host is not) |
| Session cookie | `tv_session`, `HttpOnly`, `SameSite=Lax`, 12-hour TTL, `Secure` only outside `development`/`test` |
| CSRF cookie | `tv_csrf`, readable by script, same lifetime and flags |
| Credential source of record | `%LOCALAPPDATA%\TruevineVoice-QA-Recovery\<operation-id>.dpapi` |

Use **one** host for the whole session. The examples above use `localhost` for
the browser apps; do not switch to `127.0.0.1` mid-session, because that is a
different cookie jar.

## Start the API against the QA database

`NODE_ENV` must be `development` (or `test`). Both are treated as plain-HTTP
environments, so cookies are not marked `Secure`. Every other value is treated
as HTTPS.

```powershell
$env:NODE_ENV = 'development'
$env:DATABASE_URL = '<approved local QA connection string>'
$env:EXPECTED_DATABASE_NAME = 'truevine_bootstrap_test_a1b2c3d4e5f67890'
$env:API_HOST = '127.0.0.1'
$env:API_PORT = '3001'
npm.cmd run build:api
node --enable-source-maps apps/api/dist/main.js
```

Supply `DATABASE_URL` from a private environment loader. Never paste it into a
command, a file in the repository, or a terminal transcript: it carries the
database password.

The boot log must contain:

```text
listening on http://127.0.0.1:3001 (env=development, version=0.1.0)
database: truevine_bootstrap_test_a1b2c3d4e5f67890
```

If it says any other database, stop. The process is serving data the QA
accounts do not exist in, and every sign-in will fail with
`invalid_credentials`.

If `EXPECTED_DATABASE_NAME` is set and does not match, start-up fails with:

```text
Refusing to start: DATABASE_URL selects database "X" but EXPECTED_DATABASE_NAME is "Y".
```

That error is the interlock working. Fix the connection string; do not unset the
variable to get past it.

## Sign in

1. Open `http://localhost:3000/sign-in` in a fresh browser profile.
2. Read the password from the approved local bundle:
   `%LOCALAPPDATA%\TruevineVoice-QA-Recovery\Open-QACredentials.ps1`.
   The helper verifies the directory ACL and owner, checks the bundle's
   database, operation ID and both identities, and displays the passwords in a
   read-only, masked field. There is deliberately no clipboard export and no
   terminal output.
3. Sign in. The browser receives `tv_session` and `tv_csrf` for `localhost`.
4. Open `http://localhost:3002/admin` (or `/admin/support`) on the same host.
   The admin proxy forwards the session cookie and bootstraps `tv_csrf` from
   `GET /admin/api/auth/terms` before any mutation, so sign-out and role
   changes work on a browser that has never visited the web app.

Sessions are stored in PostgreSQL and read on every request. Restarting the API
does **not** sign anyone out, provided `DATABASE_URL` is unchanged. Reloading the
page does not either. Only sign-out, an expired 12-hour TTL, a password change,
or an explicit session revocation ends a session.

## Triage a 401, in this order

Do these checks before concluding that a password is wrong. Each is read-only.

1. **Which database is the API serving?** Read the boot log for
   `database: <name>`. It must be the QA database.
2. **Which database is it connected to?**
   ```powershell
   docker exec truevine-postgres psql -X -U truevine -d postgres `
     -c "SELECT datname, count(*) FROM pg_stat_activity WHERE datname LIKE 'truevine%' GROUP BY datname;"
   ```
   The QA database must show the API's connection.
3. **Which host is the browser on?** `localhost` and `127.0.0.1` are different
   cookie jars. Check the address bar, not the page.
4. **Is the session still live?**
   ```powershell
   docker exec truevine-postgres psql -X -U truevine -d truevine_bootstrap_test_a1b2c3d4e5f67890 `
     -c "SELECT u.email, s.created_at, s.expires_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.revoked_at IS NULL AND s.expires_at > now() ORDER BY s.created_at DESC;"
   ```
   No row means the 12-hour TTL elapsed or the session was revoked. Sign in
   again; that is not a credential fault.
5. **Is the account healthy?**
   ```powershell
   docker exec truevine-postgres psql -X -U truevine -d truevine_bootstrap_test_a1b2c3d4e5f67890 `
     -c "SELECT email, status, failed_login_count, locked_until FROM users WHERE email LIKE 'qa-%@truevoice.com' ORDER BY email;"
   ```
   `ACTIVE` with an expired `locked_until` is fine: the next successful sign-in
   resets the counter. `SUSPENDED` is not something to fix by resetting a
   password.
6. **Only then suspect the credential.** Re-open the DPAPI bundle. If it is
   missing or unreadable, do not reset the password ad hoc: use the approved
   recovery procedure in
   [Local QA platform account recovery](./local-qa-platform-recovery.md).

Never probe the real accounts repeatedly to "see if it works now". Sign-in
lockout is per account, and each failure is audited as
`auth.sign_in.failed`.

## Rules

- **Do not reset the QA passwords to fix a 401.** The password is usually not
  the fault, and a reset invalidates the approved bundle and revokes sessions.
- **Do not create replacement accounts.** These two identities are referenced by
  ID in audits, tests and other runbooks.
- **Do not print, copy or commit a password.** The DPAPI bundle is the only
  approved local store. It is bound to the current Windows user and machine.
- **Do not point the API at `truevine_voice` to "try it".** The QA accounts do
  not exist there, and writes would land in the development database.
- **Do not relax `Secure`, `SameSite` or CSRF to make a local flow pass.**
  `development` and `test` are already non-`Secure`; that is the only exception.

## Regression coverage

These tests exist so the three faults above cannot return silently:

| Test | Guards |
| --- | --- |
| `apps/api/test/cookies.spec.ts` | `Secure` only outside `development`/`test`; `HttpOnly` on the session cookie only; 12-hour lifetime; malformed cookie handling |
| `apps/api/src/config/api.config.spec.ts` | database-name derivation, `EXPECTED_DATABASE_NAME` refusal, boot on a matching database, rejection of a URL with no database |
| `apps/admin/src/app/api/proxy.spec.ts` | `GET /auth/terms` is forwarded; paths outside the allowlist are still refused |
| `apps/admin/src/lib/api.spec.ts` | CSRF bootstrap before a mutation, reuse of an existing cookie, no bootstrap on reads |
