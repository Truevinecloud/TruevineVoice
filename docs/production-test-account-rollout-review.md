# Production test-account rollout preparation report

Date: 2026-10-23. Branch: `feat/qa-role-test-kit`. Base: `0480655172b610301f97592ca26ec2c1fb59b914`.

Status: **review package prepared, not independently approved or executed**. The public application retains its production classification. No production connection, existing-account inspection, account creation, bootstrap, password change, HTTP sign-in, role probe, migration, commit, push, merge, Actions dispatch or deployment occurred. No live success is claimed.

## Files created or changed in this task

- `docs/production-test-account-inventory.json`: eleven dedicated fictional `@truevoice.com` identities, exact role/scope, separate preserved `admin@truevoice.com`, execution authorization explicitly false. Contains no passwords or usable execution approval and is not consumed by an executable command.
- `docs/runbooks/production-test-account-rollout.md`: staged production procedure, independent approval gates, read-only preflight, target/cluster checks, immutable first-owner initialization, protected no-email password setup, conflict decisions, production-executor requirements, CI/CD plan, retirement and rollback.
- `docs/runbooks/production-test-account-http-checklist.md`: exact actual-HTTPS sign-in protocol, CSRF/session/terms handling, eleven role-specific allowed/denied cases, tenant boundaries, interface checks, logging restrictions, mutation review and evidence criteria. Every live result is NOT RUN.
- `docs/runbooks/README.md`: discoverability links for the two review documents.
- `docs/production-test-account-rollout-review.md`: this report.

Completed seeder implementation/tests, bootstrap code, permission registry, Prisma schema, migrations, migration approval manifest, workflows and all existing work were preserved without edits in this task.

## Commands executed, in order and outcomes

1. `git status --short --branch`, `git rev-parse HEAD`, and targeted `Get-Content` reads of README, ADR 0014, bootstrap runbook/code, completed seeder, auth controller/cookies and deploy workflow: succeeded and confirmed the correct branch/base, prior work and protected bootstrap/deploy contracts. Large combined output was truncated; follow-up targeted reads covered needed details.
2. Controller decorator searches with `rg`, CSRF guard/proxy/auth source reads, migration-manifest discovery, runbook index and existing activation/E2E code searches: inspected route/permission contracts. An exploratory `me.controller.ts` path did not exist; GET `/me` was located in `organizations.controller.ts`. Some optional exploratory file reads returned no content; no missing endpoint was invented.
3. Targeted reads of `infrastructure/migrations-reviewed.json`, operations/billing/support/organizations/campaigns controllers, API client, audit metadata rules and owner recovery runbook: confirmed current migration listing, account-recovery boundaries and safe metadata requirements. No live ledger or production credentials were read.
4. Targeted reads of API target resolution, campaign service/controller, cookie/CSRF setup, bootstrap/shared TTLs, operations/technical definitions and deployment migration function: confirmed `/api` proxy default, DRAFT campaign creation, 24-hour bootstrap artifact versus one-hour shared recovery token, and controlled deployment migration execution. A search for nonexistent `deploy-release.mjs` reported a missing file; the actual implementation was read in `deploy.mjs`.
5. Applied documentation and review-only inventory changes only.
6. PowerShell JSON/registry validation: **passed**. Verified executionAuthorized=false, exactly eleven unique identities with the requested fictional domain, the exact supported eleven registry roles, and five organization/six platform scopes.
7. PowerShell relative-link validation for both new runbooks: **passed**.
8. `git diff --check`: **passed**, no whitespace errors. Existing package.json LF-to-CRLF warning remains from prior work, unrelated to this documentation change. `git status --short --branch` confirmed intended prior changes plus this review package.
9. Final JSON parse and `git diff --check` after writing this report: performed before handoff.

## Verification and limitations

No lint, typecheck, unit test, build, real PostgreSQL test or live HTTP test ran in this documentation-only task. Previous local seeder results remain historical evidence in `docs/test-account-seeder-results.md`; they do not satisfy production acceptance. Static checks above validate the review artifacts only.

The current source manifest lists bootstrap migrations, while historical ADR/runbook text says those migrations were excluded. The procedure explicitly requires resolving this against the actual authorized production ledger/release and current approvals; no source file was silently corrected and no deployment gate was relaxed.

The existing bootstrap must issue its protected one-time token. The proposed named custodian can consume that token through the existing CSRF-protected HTTPS completion endpoint with a password from private configuration, then sign in normally. No email or tester-facing activation link is required. The private HTTP client still needs implementation/review/rehearsal; bootstrap approval, singleton, audit and target checks remain intact.

The completed local seeder intentionally rejects production and `.com` inventory. This task does not turn it into a production command. A separately reviewed production batch executor, credential contract, durable operation/provenance mechanism, disable path and private HTTP verifier must be implemented and rehearsed on isolated Linux/PostgreSQL/HTTPS before release authorization. There is no presently approved runnable command for the remaining ten production accounts or their cleanup.

All eleven dedicated accounts can have actual HTTP authentication tested after authorization. However, platform Billing Admin has no implemented billing endpoint/dashboard; its login/denial checks cannot prove nonexistent permitted functionality. Other missing matrix consumers and mutation/fixture-specific cases are explicitly pending/unavailable, never passed.

`admin@truevoice.com` remains additional to the eleven dedicated identities. Its user-reported ACTIVE status is not a live finding from this task. It must not be modified, adopted or probed for a password automatically. Reviewer approval of an alternative inventory that reuses it would require an explicit membership/credential decision.

## Required authorization before execution

The rollout runbook defines separate gates for inventory/scope; production implementation and isolated rehearsal; exact schema/release/deployment; first-owner bootstrap; the remaining ten accounts/private credentials; HTTP tests; and retirement. Database identity, cluster fingerprint, no-conflict findings and immutable operation IDs must bind those approvals to a concrete release and target. The current request authorizes preparation only and supplies none of the execution records. Code rollback never deletes or reopens the bootstrap claim, restores credentials, or erases audit history.
