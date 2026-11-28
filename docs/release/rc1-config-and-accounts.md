# RC1 configuration and accounts (preparation only)

This document lists **environment variable names only**. No value, credential, connection
string, key, token, email address or private file content is recorded here. No account or
configuration change has been executed.

## 1. Configuration matrix

"Default/safe state" describes code behaviour only; it is not a production setting.

| Variable | Used by | Default/safe state | Production action | Approval gate |
| --- | --- | --- | --- | --- |
| `AT_API_KEY` | Worker `CampaignExecutionModule` (`apps/worker/src/campaigns/campaign-execution.module.ts:40`) | Unset; required only if `AT_VOICE_PROVIDER` is enabled | Secret manager only; never in repository or logs | Voice dispatch + provider activation |
| `AT_CALLBACK_API_KEY` | API `AfricaTalkingCallbackModule` (`apps/api/src/africas-talking-callback/africa-talking-callback.module.ts:20-21`) | Provider resolves to `null`; module unregistered | Supply only through approved secret path if callback ingress is approved | Callback ingress |
| `AT_ENVIRONMENT` | Worker adapter selection (`campaign-execution.module.ts:42`) | Unset; adapter selection fails if provider flag enabled without it | Owner decision; no live environment selected here | Voice dispatch |
| `AT_USERNAME` | Worker adapter selection (`campaign-execution.module.ts:39`) | Unset; required only if `AT_VOICE_PROVIDER` is enabled | Secret manager only | Voice dispatch |
| `AT_VOICE_NUMBER` | Worker adapter selection (`campaign-execution.module.ts:41`) | Unset; required only if `AT_VOICE_PROVIDER` is enabled | Owner-approved provider number only | Voice dispatch |
| `AT_VOICE_PROVIDER` | Worker adapter selection (`campaign-execution.module.ts:38,68`) | Unset/`false` selects `FakeVoiceAdapter`; no real provider | Keep disabled until explicitly approved | Voice dispatch |
| `AUDIO_STORAGE_BACKEND` | API `StorageRouter` (`apps/api/src/audio/storage/storage-router.ts:23-37`) | Unset selects `POSTGRESQL`; explicit `S3` requires S3 config | Decide storage policy; no live object-store change here | Migration/storage policy |
| `CAMPAIGN_EXECUTION_MODE` | Worker `CampaignExecutionModule` (`campaign-execution.module.ts:29-35`) | Defaults to `disabled`; module itself unregistered | Keep disabled until approved | Campaign execution activation |
| `CAMPAIGN_EXECUTION_QUEUE_NAME` | Worker queue metrics/processor/observability (`apps/worker/src/health/queue-metrics.service.ts:23`, `campaign-execution.processor.ts:12`, `observability.service.ts:150`) | Falls back to the code-defined queue name; no job processing wired | Confirm name only if execution is approved | Campaign execution activation |
| `DATABASE_TRANSACTION_TIMEOUT_MS` | API `InfrastructureModule` (`apps/api/src/infrastructure/infrastructure.module.ts:41-45`) | Unset; Prisma default applies | Confirm only if an approved timeout change is needed | Config change review |
| `EXPECTED_DATABASE_NAME` | API config guard (`apps/api/src/config/api.config.ts:128-137`) | Unset; no name assertion | Use only with an independently verified controlled database name | Controlled environment verification |
| `VOICE_CALLBACK_DATABASE_URL` | Worker `CallbackWorker` (`apps/worker/src/callback-worker.ts:17-21`) | Unset disables callback worker startup; worker is unregistered | Secret manager only; no callback ingress without approval | Callback ingress |
| `VOICE_CREDENTIAL_ENCRYPTION_KEY` | API voice-provider configuration (`apps/api/src/voice-providers/voice-providers.module.ts:54`, `voice-providers.service.ts:29`) | Resolves to `null`; module unregistered | Secret manager only if provider configuration is approved | Provider activation |
| `W502_SYNTHETIC_PAYMENTS_ENABLED` | API top-up integration / local payment security (`apps/api/src/payments/top-up-integration.module.ts:28`, `local-payment-security.ts:28`) | Unset/`false` = disabled; reconciliation provider refuses calls | Remain disabled in production unless separately approved | Synthetic payments + charging policy |
| `W502_SYNTHETIC_VERIFICATION_KEY` | API top-up integration (`top-up-integration.module.ts:29-31`) | Required only when synthetic payments are enabled; otherwise unused | Secret manager only; never printed | Synthetic payments |
| `W504_SMS_BILLING_AUTHORIZED` | SMS orchestration (`apps/api/src/sms/sms-fallback-orchestration.service.ts:205-206`) | Unset/`false` = billing not authorized | Keep unset; billing authorization is a separate decision | Charging policy |
| `W504_SMS_FALLBACK_ENABLED` | API `SmsFallbackModule` (`apps/api/src/sms/sms-fallback.module.ts:26-34`) | Unset/`false` selects unavailable SMS port; module unregistered | Keep disabled until approved | SMS activation |
| `DATABASE_URL` | API/database client,Prisma scripts, deployment activation (`README.md:641`, `deploy.mjs:253-279`) | Required; no default | Supplied only from the existing protected `.env` | Controlled environment access |
| `REDIS_URL` | API/worker Redis clients (`README.md:642`) | Required; no default | Supplied only from protected configuration | Controlled environment access |
| `PAYMENT_CREDENTIAL_ENCRYPTION_KEY` | API config (`apps/api/src/config/api.config.ts:57-82`) | Required in production; API refuses to boot without a valid key | Secret manager only; shape can be checked without printing | Repository hygiene / secret handling |
| `WEB_PUBLIC_URL` | Auth link construction (`docs/runbooks/production-deployment.md:122-134`) | Required by RBAC-001 release | Approved non-secret public URL | Config change review |
| `TRUEVINE_API_URL` | Next.js web/admin server-side API origin (`production-deployment.md:134-140`) | Supplied by PM2 ecosystem; not a `NEXT_PUBLIC_` value | Keep internal-only; no admin publication | Admin exposure |
| `EMAIL_TRANSPORT` | Email config (`production-deployment.md:142-143`) | Optional; defaults to `none`, recording sends without delivery | Do not set to a delivery mode until a provider account exists | Email/provider activation |
| `APP_VERSION`, `API_HOST`, `API_PORT`, `HEALTH_CHECK_TIMEOUT_MS`, `NODE_ENV`, `LOG_LEVEL` | API config/health (`README.md:639-656`) | Documented code defaults | Confirm existing protected values; no change required by RC | Config change review |

### LOCAL_CALLBACK configuration check

No `LOCAL_CALLBACK_*` **environment variable** is read in the current RC tree. The code
defines non-environment constants `LOCAL_CALLBACK_PATH` and `LOCAL_CALLBACK_KEY_HEADER`
(`apps/api/src/local-callbacks/local-callback.shared.ts:3-4`), and
`ApiConfig.localSyntheticCallback` is hardcoded to `null`
(`apps/api/src/config/api.config.ts:180`). Treat any future key-file/body-limit configuration
as **needs verification** before use; do not add literal values to this document.

### Documentation gap

`.env.example` is **unchanged** from deployed main (`git diff --quiet 8fcb552...HEAD -- .env.example`
exit 0). The RC-specific names in the first 17 rows above are not documented there. This is an
RC documentation gap to be reconciled by the owner before release; no example file was edited here.

## 2. Accounts matrix

"Existing deployment state" is **needs verification** for a live environment: this static
review cannot inspect production identities. No literal account identifiers are included.

| Account | Existing deployment state | RC action | Approval | Verification |
| --- | --- | --- | --- | --- |
| Platform owner (`PLATFORM_OWNER`) | needs verification; bootstrap tooling exists but production approval is withheld (`README.md:814-829`) | None | Release/merge + any bootstrap decision | Confirm via approved operator path only |
| Operations admin (`OPERATIONS_ADMIN`) | needs verification; this is the literal role name in `packages/auth/src/permissions.ts:99-106`; there is **no** `PLATFORM_ADMIN` role | None | Admin exposure + account decision | Role registry and protected admin route check |
| QA viewer / QA owner | needs verification; isolated QA kit/runbooks exist (`docs/qa-role-permission-matrix.md`, `docs/runbooks/qa-role-test-kit.md`) | None | QA account decision | Isolated test evidence only; no production invocation |
| Tenant owner / member (`OWNER`, `ADMIN`, `CAMPAIGN_MANAGER`, `VIEWER`) | needs verification; organization roles defined at `packages/auth/src/permissions.ts:88-94` | None | Tenant data decision | Synthetic tenant checks in `rc1-migration-plan.md` |
| Billing / billing admin (`BILLING`, `BILLING_ADMIN`) | needs verification; role registry above and `docs/qa-role-permission-matrix.md:24-26` | None | Charging policy | No wallet credit, charge or refund performed |
| Provider accounts (Africa's Talking, payment providers, email transport) | needs verification; no provider account is configured by this repository | None | Provider/payment activation | Deferred; no test connection or live action |

### Explicit account constraints

- No account creation, password reset, invitation, disablement or role change was executed.
- Production email transport still blocks reset/invitation delivery; no provider account was configured
  (`docs/runbooks/production-deployment.md:142-143`).
- Provider and payment activation are deferred. No live call, SMS, charge, refund or wallet credit was performed.
- Nothing in this document grants or changes access.

## 3. Owner approval gates

| Gate | Scope | Required before | Status |
| --- | --- | --- | --- |
| Release / merge | Exact RC SHA, authoritative release PR, main CI | Merge to `main` | PENDING |
| Migration execution | 11 new SQL files, 33-entry review allow-list, exact pending names, FK drift resolution, verified backup/recovery evidence; execution only inside protected workflow | `workflow_dispatch` activation | PENDING |
| Callback ingress | `AT_CALLBACK_API_KEY`, callback module registration, receipt handling | Any callback endpoint exposure | PENDING |
| Charging policy | Usage settlement, ledger effects, SMS billing authorization | Any charge/credit/refund path | PENDING |
| Synthetic payments | `W502_*` flags and verification key handling | Any synthetic reconciliation run | PENDING |
| Voice dispatch | `AT_*` provider/environment/number selection and execution mode | Any live call | PENDING |
| Admin exposure | `OPERATIONS_ADMIN`, auditor routes, voice-provider settings routes | Any production admin access change | PENDING |
| Repository hygiene | `.env.example` gap, no committed credential-like artifacts, no secrets in logs | Release approval | PENDING |

The manifest gate is a review allow-list, not execution authority or evidence of
live application. CI uses disposable databases only; production migration
execution is limited to the protected deployment workflow after all gates. Code
rollback does not reverse SQL. Database restoration requires separate explicit
approval and is never performed over live production as part of preflight or
deployment. No gate is recorded as approved here.

## 4. Repository-hygiene validation evidence

No secret value, credential, token, connection string or key was printed or recorded.

| Check | Outcome | Evidence |
| --- | --- | --- |
| Tracked `.env` check (same assertion as `.github/workflows/ci.yml:84-91`) | `env_tracked=false` | `git ls-files --error-unmatch .env` exits non-zero as expected. |
| Tracked sensitive-looking path scan | Only safe paths listed | `.env.example`, `apps/api/src/payments/credential-cipher.ts`, its `.spec.ts`, and `docs/adr/0024-payment-provider-credential-configuration.md`. No key file, credential JSON or QA credential artifact is tracked. |
| PR #131 credential-like artifacts | Absent from this branch | Paths listed in `rc1-integration-matrix.md` were not replayed and were not read. |
| `npm audit --omit=dev --audit-level=high` | exit `1`: 2 moderate, 6 high advisories | `artifacts/npm-audit.log`; deliberately not auto-fixed in this release candidate. |

The audit result is an unresolved release warning, not evidence of a configured secret.
Any dependency upgrade must be a deliberate, separately reviewed change.
