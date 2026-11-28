# RC1 integration coverage matrix

## Scope and identity

This document records integration and disposable-environment evidence only. It does not
merge, deploy, migrate a production target, activate a provider/payment path, or change an
account. Source checks cover committed `b343dd1...` content plus the uncommitted RC
reconciliation changes listed in “Local validation evidence” below.

| Item | Value | Evidence |
| --- | --- | --- |
| Deployed `origin/main` baseline | `8fcb5527165de77ad1e2ac585c54a5a53c5217b9` | `git rev-parse origin/main` |
| PR #129 head | `253df1df5ed746f72df87b71f9c016aa3acc03a4` | object present locally; `git log` |
| PR #131 head | `51137024e089390c31cf6b557a0fa29f8d948dac` | object present locally; `git log` |
| Integration branch | `integration/production-release-rc1` at `b343dd1a5d67f1098f599b9de7ddbf5165099cdb` | `git status --short --branch`, `git log`; ahead 17 commits |
| PR #130 | Payment-intent manifest approval already on deployed main | `git show 8fcb552:.../migrations-reviewed.json` includes `20261107120000_payment_intent_foundation` |

## Provenance decisions

| Decision | Evidence / rationale |
| --- | --- |
| PR #129 is the implementation base. | It carries the coherent runtime change set; PR #131 adds mostly QA, docs, local diagnostics and admin-proxy artifacts. |
| PR #131 is used only for narrowly justified QA/docs/admin-proxy artifacts. | `git diff --name-status 253df1d..5113702` shows QA scripts, diagnostics, reports and proxy tests; it is not used as the runtime base. |
| PR #131 runtime tree is regressed and must not be used as the release runtime tree. | PR #131 removes `AnalyticsModule` from `apps/api/src/app.module.ts` and removes `QueueMetricsService`/`ObservabilityService` from `apps/worker/src/health/worker-health.module.ts`; `git diff --name-only 253df1d..5113702 -- apps/*/src packages/*/src` adds no new non-test runtime source file. |
| PR #131 contains committed credential-like files that must not enter release. | Added paths include `.qa-credentials/africas-talking-sandbox-key.txt`, `.qa-credentials/first-live-call-plan.json`, `.qa-credentials/local-callback-key`, `.qa-credentials/org-qa-credentials.json`, `.qa-credentials/w601b-qa-credentials.json`, `.qa-credentials/w601c-qa-credentials.json`. Contents were not read or reproduced. |
| Duplicate work was replayed once. | The cited commit pairs are duplicate commit IDs; `git patch-id --stable` confirms identical patches within each pair (see below). |
| PR #129 commit `6de23cd2` was intentionally skipped. | It re-listed `20261107120000_payment_intent_foundation`; deployed main already had the equivalent PR #130 manifest approval. Replaying it would add no new release change. |

### Duplicate-change verification

| Area | Cited paired commit IDs | Stable patch ID (`git patch-id --stable`) |
| --- | --- | --- |
| RBAC-013 sensitive audit | `b42ce1a9` / `02b9c944` | `ebc3424168c97111952a1d9c1047e4a6ad21056c` |
| Tenant isolation | `77a2bb14` / `b816c584` | `fd5ac0a563f2a0ff8f7ea3fbd964b37d9e1e267b` |
| RBAC-011 read-only auditor | `ad3fc593` / `a6f74b0c` | `798e611d7f92bbfa32757629271650fdafafa40b` |

## Local validation evidence (RC working tree)

All commands below ran in the isolated integration worktree. No production system,
account, provider or payment path was contacted.

| Check | Outcome | Evidence |
| --- | --- | --- |
| `npm install --package-lock-only --ignore-scripts --no-audit --no-fund` | exit `0` | Dependency lock reconciliation only. |
| `npm ci --no-audit --no-fund` | exit `0` | Clean install from the reconciled lock. |
| `npm run prisma:generate` | exit `0` | `artifacts/prisma-generate.log`. |
| `npm run prisma:validate` | exit `0` | `artifacts/prisma-validate.log`; one advisory Prisma warning about `SetNull` on a required referenced field remains (see Failures and warnings). |
| `prisma migrate diff --from-config-datasource --to-schema ... --exit-code` against `truevine_rc1_fresh` | exit `0`, empty migration | `artifacts/schema-drift-fresh.txt`. First attempt hit a transient `P1001`; an immediate retry succeeded without a schema change. |
| Same diff against `truevine_rc1_upgrade` | exit `0`, empty migration | `artifacts/schema-drift-upgrade.txt`. |
| Reviewed-manifest vs migration directories | 33 = 33, no differences | `infrastructure/migrations-reviewed.json`; `packages/database/prisma/migrations`. |
| `npm run lint` | exit `0`, `0` errors, `1` warning | `artifacts/lint.log`; the warning is the pre-existing `apps/admin/src/app/billing/page.tsx` `react-hooks/exhaustive-deps` warning. |
| `npm run typecheck` | exit `0` | `artifacts/typecheck.log`, `artifacts/typecheck.exit`. |
| `npm run build` | exit `0` | `artifacts/build.log`, `artifacts/build.exit`. |
| `npm test` | exit `0` | `artifacts/test.log`, `artifacts/test.exit`: API `70` files / `1153` tests, web `33` / `379`, worker `11` / `72`, and deployment/infrastructure `15` files / `365` passed with `3` skipped; all other workspaces green. |
| Focused disposable E2E (`campaigns`, `billing`, `payment-intents`) | exit `0`, `3` files / `37` tests | `artifacts/e2e-focused.log`. |
| Full API E2E, serial workers | exit `0`, `25` files / `314` tests | `artifacts/e2e-api-serial.log`, `artifacts/e2e-api-serial.exit`. Serial execution was used because the local loopback container cannot sustain the repository's default parallel E2E load; no timeout or assertion was changed. |
| Worker E2E | exit `0`, `1` file / `5` tests | `artifacts/e2e-worker.log`, `artifacts/e2e-worker.exit`. Uses `REDIS_URL=redis://localhost:56379`, matching CI; an IP-literal URL does not populate ioredis `stream.remotePort` on Windows. |
| `npm run test:production-rollout` | exit `0`, `2` files / `33` tests | `artifacts/test-production-rollout.log`. Follows the transport-aware cookie check fix in `infrastructure/scripts/production-test-http.mjs`. |
| `npm run test:security` migration gates | 5/5 gates passed; overall exit `1` locally | `artifacts/test-security.log`: empty DB, representative-row preservation, and `owners`/`identity`/`ownerless` rejection gates all passed. Its bundled E2E phase hit three concurrency timeouts on this host; the equivalent serial E2E run above is green. |
| `npm audit --omit=dev --audit-level=high` | exit `1`, 8 advisories (2 moderate, 6 high) | `artifacts/npm-audit.log`. Not silently suppressed or auto-fixed; a deliberate dependency upgrade is deferred to a dedicated change. |
| Secret hygiene | no secret value found or printed | `git ls-files --error-unmatch .env` fails as expected; tracked sensitive-looking paths are limited to `.env.example`, credential-cipher source/spec and the credential-configuration ADR. PR #131 credential-like artifacts are absent from this branch. |

Isolated migration and synthetic-data evidence is recorded in
`docs/release/rc1-migration-plan.md`; those databases are disposable and were created
solely for this RC rehearsal.

### RC reconciliation fixes made during validation

| Fix | Root cause | Evidence |
| --- | --- | --- |
| Transport-aware cookie assertion in `infrastructure/scripts/production-test-http.mjs` | The verifier demanded `Secure` cookies even when its origin was plain loopback HTTP; the application deliberately omits `Secure` on HTTP so the browser does not discard the session. HTTPS rehearsals still require `Secure`; HTTP rehearsals now reject it. The unit fixture origin was aligned with the HTTPS cookies it serves. | `artifacts/test-production-rollout.log` and `artifacts/e2e-rollout-focused.log` both exit `0`; no security check was removed. |
| RBAC projection contracts | The API role matrix, custom-delegation expectations and `GET /me` partial-snapshot handling were stale relative to replayed PR #129 code. A failed grant lookup now fails closed with `permissions_unavailable` instead of returning a partial permission set. | `artifacts/test-api-rbac.log`: 3 files / 346 tests pass; full `npm test` green. |
| Worker observability state | Alert expectations were corrected to honour sustained/consecutive thresholds, and the shared observability snapshot now retains the latest samples. | `artifacts/test-worker.log`: 11 files / 72 tests pass. |
| Web analytics read-only contract | The viewer spec now permits filter/paging/CSV controls while still forbidding `Launch`, `Edit`, `Delete`, `Pause`, `Resume` and `Cancel`. | `artifacts/test-web-readonly.log`: 1 file / 5 tests pass. |

## Integration commits currently on the branch

Verified with `git log --oneline --no-merges origin/main..HEAD` (oldest first).

| Commit | One-line purpose |
| --- | --- |
| `306f6b2` | Replayed duplicate RBAC-011, tenant-isolation and sensitive-audit changes as the integration base. |
| `0e5c067` | Added tenant custom-role store/service/controller and effective-permission calculation. |
| `af15a8f` | Added PostgreSQL BYTEA audio storage, storage router and organization quota guard. |
| `62caf24` | Added BullMQ campaign execution, claim/reconciliation services and fail-closed dispatch guard. |
| `f30f04d` | Added Africa's Talking voice adapter, callback module/controller and provider configuration service. |
| `35e9c82` | Added durable callback receipts, synthetic local callback ingress and callback job plumbing. |
| `172cb42` | Added usage settlement and synthetic top-up reconciliation code. |
| `3621755` | Added read-only analytics backend, read adapter/controller and reporting dashboard. |
| `670701c` | Added fail-closed SMS fallback, synthetic adapter and entitlement migrations. |
| `c3649d5` | Added shared metrics/alerting/resource collectors and worker metrics/observability services. |
| `831e975` | Added shared UI primitives/design tokens and RBAC role screens. |
| `bb88456` | Finalized the 33-entry migration manifest and worker health wiring. |
| `d77b715` | Corrected compilation, lint and test failures from PR #129 integration. |
| `ecf207e` | Resolved Prisma P1012 validation errors and integrated RBAC type contracts. |
| `61f744a` | Completed effective-permission and callback configuration contracts. |
| `71e8186` | Restored shared UI exports and corrected web analytics gating. |
| `b343dd1` | Mapped the Prisma enum to the reviewed SQL identifier `audio_storage_backend`; no migration was edited. |

## Static wiring facts

| Fact | Current RC evidence |
| --- | --- |
| PR #129 alone registers API `AnalyticsModule` among the two PR heads. | PR #129 `apps/api/src/app.module.ts` imports and lists `AnalyticsModule`; PR #131's version omits it. Current RC restores/registers it at `apps/api/src/app.module.ts:3,48`. |
| PR #129 alone registers worker `QueueMetricsService` and `ObservabilityService` among the two PR heads. | PR #129 `apps/worker/src/health/worker-health.module.ts` lists both; PR #131's version contains only `WorkerReadinessService`. Current RC lists both at `apps/worker/src/health/worker-health.module.ts:3,5,16-19`. |
| Most new modules are unregistered at the PR heads. | Verified at both heads; see the matrix below for what the RC branch actually registers now. |
| Current RC API root registers `AuditModule`, `AudioModule` and `AnalyticsModule`, but not the new custom-role, callback, provider, SMS, top-up or API observability modules. | `apps/api/src/app.module.ts:29-49`; grep shows those modules only in their own files. |
| Current RC worker root registers only `WorkerConfigModule`, `RedisModule` and `WorkerHealthModule`; `CampaignExecutionModule` and `CallbackWorker` are not registered. | `apps/worker/src/app.module.ts:14-16`; grep for `CampaignExecutionModule` / `CallbackWorker` outside their definitions found no root registration. |
| `packages/ui` exists and exports primitives, but no current app imports `@truevine/ui`. | `packages/ui/src/index.ts`; grep across `apps` found no `@truevine/ui` imports. |

## Feature coverage matrix

Status vocabulary: `implemented-and-wired`, `implemented-but-not-enabled`, `deferred`,
`requires-approval`. "Wired" means registered in a running root module in the
checked-out RC tree; it does **not** mean deployed or enabled in production.

| Area | main | PR #129 | PR #131 | RC integration status | Evidence/notes |
| --- | --- | --- | --- | --- | --- |
| Custom roles / effective permissions | deferred | implemented-but-not-enabled | implemented-but-not-enabled | implemented-but-not-enabled; requires-approval for migration and any assignment | `CustomRolesModule` exists at `apps/api/src/custom-roles/custom-roles.module.ts:13` but is absent from `apps/api/src/app.module.ts`. Effective-permission read is reachable through `OrganizationsController` (`apps/api/src/organizations/organizations.controller.ts:300`), backed by `OrganizationsService.effectivePermissions` (`organizations.service.ts:981`). Migration `20261119134000_rbac_015_custom_roles` is listed but not executed. |
| RBAC-011 read-only auditor | implemented-and-wired (base role and admin route) | implemented-and-wired (expanded UI/tests) | implemented-and-wired (expanded UI/tests) | implemented-and-wired (code); requires-approval for any account role change | `PLATFORM_ROLES` includes `AUDITOR` (`packages/auth/src/permissions.ts:99-106`); admin auditor workspace at `apps/admin/src/app/auditor/*`. No production role assignment was performed. |
| Tenant isolation | implemented-but-not-enabled (partial backend/docs) | implemented-and-wired (backend/workspace) | duplicate of PR #129 | implemented-and-wired; requires-approval for live cross-tenant verification | Replayed via `306f6b2`; API transaction rechecks and workspace context tests exist (`apps/api/test/tenant-isolation.e2e-spec.ts`, `apps/web/src/app/app/organization-isolation.spec.tsx`). Live tenant checks remain PENDING. |
| Sensitive audit | implemented-and-wired (base audit) | implemented-and-wired | duplicate of PR #129 | implemented-and-wired; requires-approval for migration execution | `AuditModule` is registered (`apps/api/src/app.module.ts:46`); sensitive audit service/middleware present (`apps/api/src/auth/sensitive-audit.ts`). Migration `20261021150000_sensitive_audit_integrity` is baseline, not re-executed here. |
| Audio PostgreSQL storage | implemented-but-not-enabled (S3/metadata path) | implemented-and-wired | implemented-but-not-enabled (storage changes retained, observability wiring removed) | implemented-and-wired; requires-approval for migration execution and storage policy | `AudioModule` is registered (`apps/api/src/app.module.ts:47`); `StorageRouter` defaults to `POSTGRESQL` when `AUDIO_STORAGE_BACKEND` is unset (`apps/api/src/audio/storage/storage-router.ts:23-37`). Enum is mapped to `audio_storage_backend`; `AudioAssetUsage.campaign` now declares `onDelete: SetNull`, matching reviewed SQL, with no migration edited. Both disposable schema-drift checks exit `0`. |
| BullMQ campaign execution | deferred | implemented-but-not-enabled | implemented-but-not-enabled | implemented-but-not-enabled | `CampaignExecutionModule` exists (`apps/worker/src/campaigns/campaign-execution.module.ts:84-139`) but is absent from `apps/worker/src/app.module.ts:15`. `CAMPAIGN_EXECUTION_MODE` defaults to `disabled` (same file, lines 29-35). |
| Africa's Talking adapter | deferred | implemented-but-not-enabled | implemented-but-not-enabled | implemented-but-not-enabled | Adapter lives behind the telephony port at `packages/telephony/src/adapters/africas-talking/*`. `AT_VOICE_PROVIDER` must be explicitly set to select it (`apps/worker/src/campaigns/campaign-execution.module.ts:37-57`); no credential or live call path was activated. |
| Durable callback receipts | deferred | implemented-but-not-enabled | implemented-but-not-enabled | implemented-but-not-enabled | `CallbackReceipts` in `packages/telephony/src/callback-receipts.ts`; API `AfricaTalkingCallbackModule` and local callback module are unregistered; `CallbackWorker` is unregistered (`apps/worker/src/callback-worker.ts:9`). `AT_CALLBACK_API_KEY` provider exists but module is not in `AppModule`. |
| Wallet settlement / top-up reconciliation | deferred (payment-intent foundation only) | implemented-but-not-enabled | implemented-but-not-enabled | implemented-but-not-enabled; requires-approval for charging policy | `TopUpIntegrationModule` exists (`apps/api/src/payments/top-up-integration.module.ts:18-42`) but is unregistered. `UsageSettlement` exists in the worker but is not wired. Synthetic payment flags default to disabled. Main already had PR #130's payment-intent manifest entry. |
| Analytics | deferred | implemented-and-wired | implemented-but-not-enabled (wiring removed) | implemented-and-wired (API registration only); requires-approval for production data exposure | `AnalyticsModule` registered at `apps/api/src/app.module.ts:3,48`; read adapter/controller at `apps/api/src/analytics/*`; dashboard at `apps/web/src/app/app/reports/analytics-dashboard.tsx`. PR #131 removes the API registration. |
| SMS fallback | deferred | implemented-but-not-enabled | implemented-but-not-enabled | implemented-but-not-enabled; requires-approval for billing authorization | `SmsFallbackModule` exists (`apps/api/src/sms/sms-fallback.module.ts:20-42`) but is unregistered. SMS port is unavailable unless `W504_SMS_FALLBACK_ENABLED` is set; billing authorization is separately gated by `W504_SMS_BILLING_AUTHORIZED`. |
| Observability | deferred | implemented-and-wired (worker services) | implemented-but-not-enabled (worker services removed) | implemented-and-wired in worker; implemented-but-not-enabled in API | Worker `QueueMetricsService` + `ObservabilityService` registered at `apps/worker/src/health/worker-health.module.ts:16-19`; API `ObservabilityModule` exists at `apps/api/src/observability/observability.module.ts:19` but is not imported by `AppModule`. |
| Shared UI / RBAC | deferred | implemented-but-not-enabled | implemented-but-not-enabled | implemented-but-not-enabled | `packages/ui` primitives and role pages exist; no app imports `@truevine/ui`. `71e8186` restored exports; consumption remains absent. |
| Migration manifest / worker health | requires-approval (22 baseline entries) | requires-approval (33 entries) | requires-approval (same manifest, regressed worker wiring) | worker health implemented-and-wired; migration manifest requires-approval | `infrastructure/migrations-reviewed.json:19-52` has 33 entries. Worker health services are wired as above. Manifest permits code to deploy; it does not permit migration execution. See `rc1-migration-plan.md`. |

## Not merged/not deployed

- This integration branch is **not merged** into `main`.
- No RC commit has been deployed. Deployed baseline remains `8fcb552...`.
- The manifest, module registrations and tests are static evidence only; production status
  of data, schema and processes is **needs verification** through the approved operator path.

## No provider/payment/live call activation

- No Africa's Talking credential, callback key, voice dispatch, or live call was activated.
- No synthetic or real payment collection, charging, refund, wallet credit, or reconciliation
  run was executed against a non-disposable target.
- No SMS send or billing authorization was enabled.
- The only currently wired analytics/observability paths are read-oriented and were not
  exercised against production.

## No production accounts changed

- No production account was created, invited, password-reset, disabled, or role-changed.
- No platform owner bootstrap, QA recovery, or tenant membership mutation was executed.
- Production email transport still blocks reset/invitation delivery; no provider account was
  configured. See `docs/runbooks/production-deployment.md:142-143`.
