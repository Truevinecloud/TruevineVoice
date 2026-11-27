# Local development server status

Coordination snapshot taken 2026-11-23 after restoring the browser-facing UI servers.

| Service | Port | State | Owner / note |
| --- | --- | --- | --- |
| Web app | 3000 | Listening (PID 23696) | Restored by OpenCode; `npm run dev:web`, detached log `C:\Users\ntaph\AppData\Local\Temp\opencode\dev-web.log` |
| API | 3001 | Listening (PID 25116) | The earlier API process had exited (port free, admin proxy returned 503); OpenCode restored it from `apps/api` with `node dist/main.js`, log `C:\Users\ntaph\AppData\Local\Temp\opencode\dev-api.log` |
| Admin app | 3002 | Listening (PID 1632) | Restored by OpenCode; `npm run dev:admin`, detached log `C:\Users\ntaph\AppData\Local\Temp\opencode\dev-admin.log` |
| W402 Redis | 56379 | Listening (PID 11568) | Isolated test Redis; untouched |

A separate worker process (PID 22868) was already running from `apps/worker/start-local.ps1` and was left untouched.

Do not kill or restart ports 3001 or the existing worker without coordinating with the agent that started them. Web/admin were the only stopped services and were restored without changing API, worker, database or migration state.

## Admin route alias fixes (2026-11-23 follow-up)

Visible Chrome testing found two manually entered compatibility URLs returning the Next.js 404 page:

- `/admin/platform-admins` — added `apps/admin/src/app/platform-admins/page.tsx`.
- `/admin/audit` — added `apps/admin/src/app/audit/page.tsx`.

Both use the shared client-side `apps/admin/src/app/route-alias.tsx` redirect. A server-side `redirect()` was rejected because it double-prefixed the configured `/admin` base path; the client router preserves it. The aliases redirect to the authorized real routes (`/platform-admin` and `/auditor`) rather than duplicating any permission logic.

Verified in the visible Chrome tab:

- `/admin/platform-admins` → `/admin/platform-admin`, heading **Platform administrators**, no 404, no console errors.
- `/admin/audit` → `/admin/auditor`, heading **Audit**, no 404, no console errors.
- Full admin route sweep (21 admin URLs including all platform nav sections and technical/support/auditor subpages): no 404s remain. `/admin/support/access` records one expected 403 console entry for the current role's limited support-access capability; the page renders its access notice correctly.
- Full web route sweep (15 public and `/app` URLs): no 404s. `/app` routes correctly show **Choose an authorized workspace** for the currently signed-in platform account, which has no organization membership.

Verification commands:

- `npm run typecheck --workspace @truevine/admin` — passed.
- `npm run test --workspace @truevine/admin` — 21 files / 141 tests passed.
- ESLint on the four new alias files — passed.

## API restoration and sandbox credential check (2026-11-23 follow-up)

The API on port 3001 was already gone when the superadmin sign-in returned `503`; the port was
free and `/health` was unreachable. OpenCode rebuilt `@truevine/api` and restarted it as PID
25116 from `apps/api` (`node dist/main.js`). Web (3000), admin (3002), the worker and the W402
Redis were not touched.

Restarting and rebuilding had two side effects, both corrected and recorded:

- The rebuilt artifact initially picked up an uncommitted `AfricaTalkingCallbackModule` import
  and exposed `POST /webhooks/africastalking`. Public callback ingress is not approved, so the
  import and module entry were removed from `apps/api/src/app.module.ts` (module files kept).
  After the rebuild the route is absent and a loopback probe returns `404`.
- A local `VOICE_CREDENTIAL_ENCRYPTION_KEY` was added to the gitignored root `.env` so the
  encrypted voice-provider surface can write credentials. It is not committed.

Sandbox credentials for Africa's Talking are now stored encrypted and verified read-only; see
`docs/w4-03-sandbox-credential-verification.md`. Dispatch remains disabled (`enabled = false`,
`voiceReady = false`), production has no row, and no call was placed.

## W5-03E isolated QA stack (2026-11-24)

OpenCode is running a **dedicated W5-03E browser-acceptance stack** and will not touch another
agent's services. Other agents (including Kilo Code and GitHub Copilot) should not stop, restart,
reconfigure or reuse these resources until W5-03E acceptance is recorded:

| Resource | Value | Owner / note |
| --- | --- | --- |
| Web | `http://localhost:3100` | W5-03E only; Next.js dev web. Listener PID 22344, parent `cmd.exe` PID 15160. Log `C:\Users\ntaph\AppData\Local\Temp\opencode\w503e-web.log`. |
| API | `http://localhost:3101` | W5-03E only; API PID 21832. Log `C:\Users\ntaph\AppData\Local\Temp\opencode\w503e-api.log`. `/health` returned 200 with PostgreSQL/Redis up. |
| Redis | container `truevine-w503e-redis`, host `127.0.0.1:56381` | W5-03E only; do not confuse with W402 Redis on 56379. |
| PostgreSQL database | `truevine_w503e_qa` on existing local PostgreSQL `localhost:55432` | W5-03E only; all 30 migrations applied after verifying the target name. Never point this stack at `truevine_voice` or another database. |
| Synthetic identities | `w503e-owner-a@example.invalid` (OWNER), `w503e-owner-b@example.invalid` (OWNER), `w503e-billing@example.invalid` (BILLING, no `reporting:read`) | Credentials and one-time activation artifacts live only under `C:\Users\ntaph\AppData\Local\Temp\opencode\`. |

Existing services on 3000/3001/3002, Redis 56379, the local worker, Docker containers
`truevine-postgres`/`truevine-redis`, and other worktrees are untouched by this task. W5-03E uses
its own ports and database, and only synthetic evidence is being seeded.

W5-03E browser acceptance passed on 2026-11-24; see `docs/w5-03e-browser-acceptance.md`.
The dedicated stack above was left running for evidence reproducibility and has not been
released for reuse by another task. Close or reuse it only after that acceptance record is no
longer needed.
