# RBAC-003 backend authorization coverage

Base: verified remote main `e0130adea7544d4b57bfc07b2cf575f1684847e3`.
Branch: `test/rbac-003-authorization-coverage`, isolated worktree
`.worktrees/rbac-003-authorization-tests`. Existing root changes are preserved.

## Changes and acceptance evidence

- Real HTTP session, terms, organization/platform and CSRF guards refuse Campaign
  Manager membership changes/removal (including protected Owner targets),
  invitation listing/creation/revocation, ownership transfer and organization
  updates with 403 `permission_denied`. Business-service spies remain untouched.
- All implemented Operations, Technical, Audit and Support controller endpoints
  are exercised as a Campaign Manager without a platform assignment. Ordinary
  routes return 403 `permission_denied`; diagnostics returns its existing
  dedicated 403 when no support context is supplied. No support session is created.
- Existing billing role-denial tests now submit valid mutation payloads, assert
  `permission_denied`, compare business state and prove neither write method ran.
  This includes wallet balance/history, billing reads/updates and pending top-ups.
  No customer wallet adjustment endpoint exists; no fictitious endpoint is added.
- Real AudioService/HTTP tests use typed fake persistence, object-storage and TTS
  ports. Campaign Manager listing, voices, WAV recording, synthesis and playback
  succeed using synthetic bytes. Foreign organization paths return 403 before
  any port call; scoped missing/foreign playback IDs return 404 without signing.
  Billing/Viewer creation, stale membership, terms and CSRF boundaries are tested.
- Contacts HTTP coverage adds Campaign Manager import and consent/suppression
  routes, authenticated path/actor forwarding despite forged body fields,
  foreign-path 403s, role denials and membership removal. These are HTTP routing
  contracts with service fakes; they do not establish import persistence races.
- Campaign Manager draft CRUD, preflight and reports are exercised through the
  real service with fake persistence. Lifecycle activation is still refused.
  Every campaign route is tested against a foreign organization path.
- Central route checks include Contacts and Audio session/CSRF/terms guards and
  an explicit, complete handler-to-permission contract.
- Campaign/audio PostgreSQL E2E hooks validate the existing disposable URL and
  environment allowlist, then check `current_database()` before any cleanup or
  fixture write. Existing safety helper tests cover wrong URLs and mismatched
  connected database names. No database is created, reset or migrated locally.

No application authorization, provider, migration or runtime configuration was
changed. This work does not modify PR #60 or RBAC-002, merge, or deploy.

## Files created or changed

- `README.md`
- `package.json`
- `apps/api/test/audio-assets.e2e-spec.ts`
- `apps/api/test/campaigns.e2e-spec.ts`
- `apps/api/test/audio.http.spec.ts` (new)
- `apps/api/test/campaign-manager.http.spec.ts` (new)
- `apps/api/test/billing.http.spec.ts`
- `apps/api/test/contacts.http.spec.ts`
- `apps/api/test/route-guards.spec.ts`
- `docs/rbac-003-authorization-coverage.md` (new)

## Local command record and verification

Repeated source reads/polls are grouped; commands used `npm.cmd` on Windows.

1. Read README/AGENTS, authorization ADRs, registry, controllers, services,
   repositories, existing tests and workflow safety. Inspected Git status.
2. `git fetch origin main`: sandbox ref-write denial; approved retry passed.
3. `git rev-parse origin/main`, `git ls-remote origin refs/heads/main`,
   `git worktree add ... -b test/rbac-003-authorization-coverage origin/main`:
   sandbox network/ref-write denials; approved retry verified matching SHA and
   created a clean worktree. No existing files were stashed or reset.
4. `node --version`, `npm.cmd --version`: local Node 24.20.0/npm 11.19.0,
   within declared engines; CI uses exact repository pins. `docker version`:
   unavailable on PATH. A guessed audio port filename did not exist; read the
   actual `audio.port.ts` instead.
5. `npm.cmd ci --fetch-retries=0 --fetch-timeout=30000`: sandbox registry/cache
   denial; approved retry passed. Existing peer warnings and six audit findings
   (five high, one moderate); no dependency/lockfile change.
6. Applied test/safety changes; `npm.cmd run prisma:generate`: passed.
   Targeted `npm.cmd exec -- prettier --write ...` and `git diff --check`: passed
   with Windows LF/CRLF notices.
7. `npm.cmd run test:rbac-003`: first run 430 passed/44 failed because the new
   fixture supplied the contact-store token instead of ContactsService. Fixed
   fixture injection; second run all 474 passed. Two subsequent explicit
   controller-permission assertions are included in full tests below.
8. `npm.cmd run lint`: passed. `npm.cmd run typecheck`: passed all workspaces.
9. `npm.cmd test`: passed all workspaces and infrastructure static checks:
   1,598 passed, three existing infrastructure skips. API 757 passed; web 240
   passed. Existing db-verify/backup runtime wrappers report POSIX-only skips
   on Windows. No test was deleted, weakened or marked skipped by this change.
10. Negative safety probe: set `NODE_ENV=test` and a synthetic, reserved `.test`
    non-loopback PostgreSQL URL, then ran `npm.cmd run test:e2e --workspace
@truevine/api -- campaigns.e2e-spec.ts audio-assets.e2e-spec.ts`. Both hooks
    failed at the URL guard before client construction: expected nonzero result,
    32 test cases unexecuted. This is safety refusal evidence, not passing E2E.
11. `npm.cmd run build`: passed all packages and all four applications.
12. `gh auth status`: sandbox reported invalid auth; approved network retry
    confirmed the existing login. No credentials were changed.

Focused lint/guard rechecks and hosted PR results are recorded in the PR.

## Limitations and deferred work

Positive real-database E2E depends on hosted disposable infrastructure because
Docker is unavailable locally. The local negative probe is not a substitute.
Fake-port success does not establish real S3/Polly connectivity. No paid provider,
storage, TTS, outbound execution, production record or production session was used.
Read-only static observations about import transaction revocation remain outside
the HTTP coverage claim; no authorization defect was confirmed by these tests.
No speculative endpoint, provider setup, policy change or migration is introduced.
Merge and deployment require separate user approval and were not performed.
