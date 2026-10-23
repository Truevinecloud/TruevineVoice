# QA Owner recovery release security review — 23 October 2026

This review covers PR #55 and the separate dependency-remediation commit on its
branch. It does not constitute an independent human security approval.

## Next.js findings and remediation

Upstream advisories identify Next.js 16.4.0 as affected:

- [GHSA-2464-fhr4-w9xw](https://github.com/vercel/next.js/security/advisories/GHSA-2464-fhr4-w9xw):
  Image Optimization memory vulnerability on glibc Linux; the patched Next.js
  release updates the sharp dependency constraint.
- [GHSA-673q-mjm6-r5xr](https://github.com/vercel/next.js/security/advisories/GHSA-673q-mjm6-r5xr):
  remote code execution for affected Cache Component functions returning typed
  arrays; upstream recommends upgrading even without such functions.
- [GHSA-p3m5-59mp-jv5r](https://github.com/vercel/next.js/security/advisories/GHSA-p3m5-59mp-jv5r):
  Server Actions denial of service.

All three list 16.4.1 as patched. The selected exact version is **16.4.2**, the
patch-line version identified by the repository's npm audit. Customer web and
admin apps are upgraded together, along with root/app `eslint-config-next` pins.
The lockfile is regenerated normally; no forced audit fix, global lint change,
major upgrade, override or workaround is used. The dependency change is isolated
in a dedicated security commit rather than mixed into the recovery implementation.

Source searches found no current `next/image`, `use cache`, `cacheComponents` or
`use server` usage in the apps. This is a limited source observation, not proof
of non-exploitability or a substitute for patching. Existing Next.js config and
runtime architecture are retained.

After installing the reviewed lockfile, `npm ls next eslint-config-next sharp
--all` confirms Next.js/eslint-config-next **16.4.2** and **sharp 0.35.5**.
`npm audit --omit=dev --json` reports **zero vulnerabilities**. Normal install
still reports five high development-tool findings and existing ESLint peer
warnings; neither was suppressed or repaired through unrelated upgrades.

Local validation of the patched dependency set passed: repository lint,
workspace typecheck, the full unit-test command (including 13 recovery tests),
and complete package/API/worker/web/admin production builds. The full test
command retains the existing three infrastructure Vitest skips and POSIX-only
backup/database-verify runner skips on Windows. No new skips were added. The
hosted Linux/PostgreSQL rehearsal remains a separate required gate.

## Recovery review

- The target is fixed to the existing QA email and organization slug. Active
  identity, active organization and OWNER membership are rechecked under row
  locks. Platform-role holders are rejected. No provisioning or role writer is
  added, and Platform Owner/bootstrap files are untouched.
- Token generation, hash and expiry constants come from the existing auth
  package. Activation/reset tokens share the existing table and consumption
  flow. Prior unused tokens expire before replacement in the same transaction
  as the security audit. No password is accepted by this CLI.
- The supported database factory disables ORM diagnostics. CLI failure output
  omits exception details. The link is written exclusively to a 0600 file in an
  operator-owned, realpath-checked 0700 directory. Neither link nor raw token is
  printed. The required audit user reference is the recovered identity, as in
  existing operator provisioning. Explicit `local_operator`/`operating_system`
  metadata, OS UID and recovery source identify the initiating operator; this
  does not claim the recovered user initiated or authenticated the request.
- Existing application consumption changes the password, invalidates remaining
  tokens and revokes prior sessions. Issuance itself leaves password, roles,
  sessions, organizations and user records unchanged.
- Filesystem and database commit cannot be atomic. Failure cleanup, ambiguous
  commit/crash handling and deliberate replacement are documented in the runbook.

## Release gates

Run the normal quality, unit, E2E and production-build checks on the final head.
The required E2E job includes the real Linux/PostgreSQL recovery rehearsal;
restore-integration checks must also pass. Confirm production-only npm audit
no longer reports the Next.js findings. Existing development-tool advisories
must be reported separately, not hidden by a production-only audit.

An earlier rerun on recovery commit `b56199e` failed before any steps because
GitHub still reported an account billing/spending restriction. That rerun does
not verify Linux behavior. Do not merge, deploy or mark the recovery rehearsal
passed based on local Windows checks. Review actual final-head results, then
use normal PR merge, exact-main CI and the explicit production deployment
workflow. Verify the active release SHA and the `recover:qa-owner` script entry
without executing it. Production account recovery remains outside this release.
