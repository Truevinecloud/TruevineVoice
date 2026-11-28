# RC1 deployment plan (preparation only)

This plan prepares a controlled release. **No merge, push, deployment, migration,
provider activation, payment activation or live Voice/SMS action has been performed.**

## 1. Verified deployment baseline

| Fact | Value / evidence |
| --- | --- |
| Verified `origin/main` | `8fcb5527165de77ad1e2ac585c54a5a53c5217b9` (`git rev-parse origin/main`) |
| Integration branch | `integration/production-release-rc1`, HEAD `b343dd1a5d67f1098f599b9de7ddbf5165099cdb`, ahead 17 (`git status --short --branch`) |
| Deployment workflow | `.github/workflows/deploy.yml` — `workflow_dispatch` only; requires full 40-character `release_sha` and `authorize_production=true` (lines 3-15, 39-47) |
| Exact SHA enforcement | Checked-out SHA, `RELEASE_SHA` and `DEPLOY_SHA` must match; main tip must equal release SHA (`.github/workflows/deploy.yml:55-89`) |
| CI prerequisite | Completed successful main-push CI for that exact SHA; all required `ci.yml` jobs asserted (`.github/workflows/deploy.yml:68-84`) |
| Environment gates | `DEPLOYMENT_READY == 'true'`, `production` environment, pinned SSH host keys, serialized deployment (`.github/workflows/deploy.yml:20-32`, `docs/runbooks/production-deployment.md:337-353`) |
| Migration path | `deploy.mjs` applies reviewed migrations before PM2 activation and adds `-c lock_timeout=5s` (`infrastructure/scripts/deploy.mjs:248-286`) |
| Prior production evidence (supplied for this plan; **needs verification** from GitHub Actions/deployment record — not stored in the repository) | Run `46097174759`; deployment record `8123100312`; `/health` and `/` returned `200` |

## 2. Release sequence

| Step | Action | Gate / evidence | Executed? |
| --- | --- | --- | --- |
| 1 | Finish local validation on the integration SHA: `npm run prisma:validate`, `npm run lint`, `npm run typecheck`, `npm test`, `npm run build`, plus disposable E2E suites. | `docs/release/rc1-integration-matrix.md` “Local validation evidence”; all commands exit `0` except the two explicitly reported warnings/failures below. | Yes |
| 2 | Reconcile the migration plan and FK validation item (`docs/release/rc1-migration-plan.md`). | Disposable schema/SQL/FK reconciliation is DONE; controlled-environment and owner evidence remain PENDING. | Partially — controlled approval pending |
| 3 | Push **only** `integration/production-release-rc1`. Do not push to `main` or any other branch. | Operator action, not performed here. | No |
| 4 | Open/update the authoritative release PR with the integration matrix, migration plan and config/accounts plan attached. | Release/merge approval gate. | No |
| 5 | Owner approves the RC, exact SHA and migration plan. | All gates in `docs/release/rc1-config-and-accounts.md` section 3. | No |
| 6 | Merge via the normal PR path to `main`; record the exact merge SHA. | No direct push, force-push or history rewrite. | No |
| 7 | Verify main CI is green at the exact merge SHA (all four required jobs). | `.github/workflows/deploy.yml:68-84`; no PR artifact is deployable. | No |
| 8 | Controlled `workflow_dispatch` of `deploy.yml` with the exact merge SHA and `authorize_production=true`, after backup and migration approval. | `.github/workflows/deploy.yml:3-15, 39-89`; `docs/runbooks/production-deployment.md:393-427`. | No |
| 9 | Post-deploy health/route checks: `/health` status `ok`, dependencies up, `environment: production`, `APP_VERSION` equals selected SHA; verify `/` and confirmed routes from another machine. | `npm run deploy:verify -- <config-path> <SHA>`; `docs/runbooks/production-deployment.md:446-449`. | No |
| 10 | Monitor PM2, HTTP, migration ledger and error rates; retain the prior compatible READY release. | `docs/runbooks/production-deployment.md:381-414`. | No |
| 11 | Roll back via the approved path if a trigger occurs (next section). | `npm run deploy:rollback -- <previous-verified-40-character-SHA>`. | No |

### Local validation outcome

| Result | Status |
| --- | --- |
| `npm run prisma:validate`, `npm run lint`, `npm run typecheck`, `npm run build`, `npm test` | exit `0`; see `docs/release/rc1-integration-matrix.md`. |
| API E2E serial (`25` files / `314` tests) and worker E2E (`1` file / `5` tests) | exit `0`. |
| Security harness migration gates | 5/5 passed. Its bundled E2E phase hit three local concurrency timeouts; the equivalent serial E2E run is green. |
| Lint warning | One pre-existing `react-hooks/exhaustive-deps` warning in `apps/admin/src/app/billing/page.tsx`; no error suppression. |
| Prisma advisory warning | `onDelete: SetNull` on a required referenced field; schema is valid and matches reviewed SQL. |
| Dependency audit | `npm audit --omit=dev --audit-level=high` exits `1` with 2 moderate and 6 high advisories; deliberately deferred to a dedicated upgrade change. |

## 3. Explicit prohibitions

| Prohibition | Scope |
| --- | --- |
| Do not merge | No PR merge was performed; merge requires owner approval. |
| Do not deploy | No `workflow_dispatch` was triggered; deployment requires exact SHA plus explicit authorization. |
| Do not apply migrations | No local, staging or production migration was executed by this work. |
| Do not activate providers or payments | No Africa's Talking, payment, email, synthetic payment, charging or reconciliation activation. |
| Do not activate live Voice/SMS | Campaign execution and SMS modules are unregistered in the RC tree; flags remain at safe defaults. |
| Do not change accounts | No creation, invitation, password reset, role change or provider account action. |

## 4. Rollback triggers and matrix

| Trigger | Detection | Action | Reference | Approval |
| --- | --- | --- | --- | --- |
| Migration fails or ledger status is inconsistent | Activation fails before PM2 switch; `npm run prisma:migrate:status` after controlled access | Stop; inspect securely; do not blindly re-run or hand-edit SQL | `infrastructure/scripts/deploy.mjs:282-286`, `docs/runbooks/production-deployment.md:416-427` | Owner + migration approval |
| `/health` not `ok`, dependencies down, wrong `environment` or version | Post-deploy `deploy:verify` and independent HTTP check | Roll back to previous compatible READY SHA | `npm run deploy:rollback -- <previous-verified-40-character-SHA>`; `docs/runbooks/production-deployment.md:431-444` | Release approver |
| `/` or confirmed public route not `200` | Independent browser/curl check from another machine | Verify config/path first; if release-attributable, use code rollback | `npm run deploy:verify -- <config-path> <SHA>`; `docs/runbooks/production-deployment.md:446-449` | Release approver |
| PM2 process instability or failed activation checks | PM2 uptime/cwd/version checks | Protected workflow already attempts prior-release recovery; if it fails, supervised operator intervention | `docs/runbooks/production-deployment.md:405-414` | Owner |
| Cross-tenant read, audit or ledger anomaly in controlled verification | Synthetic tenant checks | Halt activation; no data edits; investigate through application/migration path | `docs/release/rc1-migration-plan.md` section 4 | Owner + security review |
| Schema change cannot be made forward-compatible | SQL/schema review | Do not activate; revise through expand/contract and re-review | AGENTS.md 12; `docs/adr/0011-reviewed-deployment-migrations.md` | Owner |

### Rollback policy notes

- Code rollback changes code only; it never reverses SQL (`docs/runbooks/production-deployment.md:440-444`).
- Restore from a vetted backup only with owner approval via `docs/runbooks/postgres-redis-recovery.md:338-355`.
- No raw destructive commands are part of this plan; use only `package.json` scripts and the cited runbooks.

## 5. Deployment / rollback matrix

| Scenario | Deploy action | Rollback action | Approval gate |
| --- | --- | --- | --- |
| CI green, approvals complete, migration evidence complete | Dispatch exact SHA with `authorize_production=true` | None expected | Release/merge + migration |
| CI green but migration approval missing | Do not deploy | N/A | Migration execution |
| Activation health check fails | Workflow restores prior release automatically where possible | `npm run deploy:rollback -- <previous-verified-40-character-SHA>` if automatic recovery fails | Release approver |
| Application defect after successful activation | No new deploy until root-caused | `npm run deploy:rollback -- <previous-verified-40-character-SHA>` | Release approver |
| Database-only regression | Stop writes at the application boundary via approved incident process; do not hand-edit data | Owner-approved restore/cutover per recovery runbook | Owner + migration |
| Provider/payment/live-call behaviour requested | Deferred; no activation path authorized | N/A | Provider/payment/live-call activation |

All statuses remain **PENDING** until an owner records explicit approval.
