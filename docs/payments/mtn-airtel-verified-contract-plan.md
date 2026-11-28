# MTN MoMo and Airtel Money verified contract plan

Status: documentation only; implementation deferred pending payment-owner confirmation of the contracts below.

Retrieval date: 2026-11-28 (UTC). All provider evidence below was retrieved on that date with `webfetch`. `websearch` returned no results for authoritative MTN/Airtel queries. No provider API, token endpoint, payment endpoint, callback listener or production system was contacted by this task.

> **No live payment activation or authorization exists.** No payment provider is configured live, no environment is activated by this change, no credentials were read or printed, and no MTN or Airtel collection, token, status, callback, reconciliation or wallet-credit path was executed. This document is a contract-evidence and implementation-planning artifact only.

## 1. Evidence standard

Only official provider documentation pages were treated as contract evidence. Where the official source was unreachable, credential-gated, internally inconsistent, or did not state a detail, the detail is marked **UNVERIFIED** and left for payment-owner confirmation. Repository files are used only to describe current Truevine implementation state; they are not evidence of a provider contract.

The interactive MTN API reference at `https://momodeveloper.mtn.com/API-collections` was retrieved, but its operation detail is rendered client-side and was not exposed by the static `webfetch` result. Operation names were verified from MTN's own Use Cases page; operation-level request examples were verified from MTN's static Use Cases and API User/Key Management pages. Swagger definitions were referenced by MTN's Common Error Codes page but were not directly retrievable here.

## 2. Sources used

| ID                | Official source URL                                                                        | Result                                                                                                       |
| ----------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| MTN-INTRO         | `https://momodeveloper.mtn.com/api-documentation/`                                         | Retrieved; documentation index and navigation.                                                               |
| MTN-GET-STARTED   | `https://momodeveloper.mtn.com/api-documentation/getting-started`                          | Retrieved; account, product subscription and key provisioning flow.                                          |
| MTN-AUTH          | `https://momodeveloper.mtn.com/api-documentation/api-description`                          | Retrieved; two-credential model, header, API user/key provisioning, OAuth 2.0, POST/GET/PUT semantics.       |
| MTN-USE-CASES     | `https://momodeveloper.mtn.com/api-documentation/use-cases`                                | Retrieved; Request to Pay flow and official MTN Collection `curl` example.                                   |
| MTN-SANDBOX       | `https://momodeveloper.mtn.com/api-documentation/testing`                                  | Retrieved; sandbox target environment and currency.                                                          |
| MTN-ERRORS        | `https://momodeveloper.mtn.com/api-documentation/common-error`                             | Retrieved; duplicate reference, subscription-key, target-environment and callback-host error contracts.      |
| MTN-CALLBACK      | `https://momodeveloper.mtn.com/api-documentation/callback`                                 | Retrieved; callback host/method/security guidance. Contains an internal method inconsistency recorded below. |
| MTN-BEST          | `https://momodeveloper.mtn.com/best-practices`                                             | Retrieved; callback, status polling, idempotency, reconciliation and credential guidance.                    |
| MTN-API-SANDBOX   | `https://momodeveloper.mtn.com/API-collections`                                            | Page retrieved; operation details rendered dynamically and not exposed to `webfetch`.                        |
| AIRTEL-DOCS       | `https://developers.airtel.com/v1.0/docs/money`                                            | Transport error; inaccessible.                                                                               |
| AIRTEL-INTRO      | `https://developers.airtel.com/v1.0/docs/introduction`                                     | Transport error; inaccessible.                                                                               |
| AIRTEL-ROOT       | `https://developers.airtel.com/` and `http://developers.airtel.com/v1.0/docs/money`        | Transport error; inaccessible.                                                                               |
| AIRTEL-ROBOTS     | `https://developers.airtel.com/robots.txt` and `https://developers.airtel.com/sitemap.xml` | Transport error; no discoverable official index.                                                             |
| AIRTEL-DEV-AFRICA | `https://developer.airtel.africa/`                                                         | Transport error; inaccessible.                                                                               |
| AIRTEL-OPENAPI    | `https://openapi.airtel.africa/` and `https://openapi.airtel.africa/docs`                  | HTTP 401 credential gate; no authoritative contract obtained.                                                |

## 3. Verified MTN MoMo Collection contract facts

### 3.1 Environments and credentials

- The portal distinguishes a test/sandbox environment and a production environment. Sandbox credentials and production credentials are provisioned separately. [MTN-GET-STARTED, MTN-AUTH]
- Sandbox API user and API key are created through a sandbox provisioning API; production provisioning is done through the User/Partner Portal. [MTN-AUTH, MTN-CALLBACK]
- A subscription key is assigned per product. Collection, Disbursement and Remittance have different subscription keys. [MTN-ERRORS]
- The subscription key is sent in the `Ocp-Apim-Subscription-Key` header on all requests sent through API Manager. [MTN-AUTH]
- In sandbox, the provisioning flow creates an API user with `POST {baseURL}/apiuser`, an `X-Reference-Id` UUID header, a subscription-key header, and a body containing `providerCallbackHost`; the API key is then created with `POST {baseURL}/apiuser/{APIUser}/apikey`. [MTN-AUTH]
- API user details can be read with `GET {baseURL}/apiuser/{APIUser}`; the API key cannot be recovered and must be regenerated if lost. [MTN-AUTH]
- The sandbox `X-Target-Environment` value is `sandbox`, and the sandbox test currency is `EUR`. [MTN-SANDBOX]
- For MTN Uganda production, `X-Target-Environment` is `mtnuganda`. [MTN-ERRORS]
- The production profile host named by MTN is `https://momoapi.mtn.com/profile`; the sandbox profile host is `https://momodeveloper.mtn.com/profile`. The production Collection API base URL was not stated in the retrieved pages and is **UNVERIFIED**. [MTN-ERRORS]

### 3.2 Authentication flow

- MTN describes two credentials: a product subscription key and an API user/API key pair granting access to a country wallet system. [MTN-AUTH]
- The API user and API key are used as HTTP Basic credentials when requesting an OAuth 2.0 access token. MTN identifies the token request as `POST /token` and the grant as the OAuth 2.0 Client Credentials Grant (RFC 6749). [MTN-AUTH]
- The access token is a bearer token (RFC 6750), treated as a credential, cached only for its validity lifetime, and reused until expiry. A fresh token is requested through `POST /token` before expiry to avoid authentication failures. [MTN-AUTH, MTN-BEST]
- The same access token is then used as `Authorization: Bearer ...` on wallet requests such as `POST /requesttopay`. [MTN-AUTH, MTN-USE-CASES]
- Tokens must never be logged; logging only expiry timestamps is allowed. [MTN-BEST]
- The exact product-scoped token URL (for example whether the Collection product prefixes the token path) was not exposed by the retrieved static pages and is **UNVERIFIED**; it must be taken from the authoritative onboarding contract or interactive operation record before implementation. [MTN-AUTH, MTN-API-SANDBOX]

### 3.3 Collection initiation and status

- MTN's Request to Pay use case is a customer-approved collection. The provider sends `POST /requesttopay` with the amount and payer account identifier; the customer approves or rejects it in their own MoMo client. [MTN-USE-CASES]
- MTN's official Collection example uses `https://sandbox.momodeveloper.mtn.com/collection/v1_0/requesttopay` with these headers: `Ocp-Apim-Subscription-Key`, `Content-Type: application/json`, `X-Target-Environment`, `Authorization: Bearer ...`, and `X-Reference-Id`. [MTN-USE-CASES]
- The official example body fields are `amount`, `currency`, `externalId`, `payer` (with `partyIdType: "MSISDN"` and `partyId`), `payerMessage` and `payeeNote`. The same example adds `transferType` only for the Aggregator variant; MTN states that `transferType` is an additional required field for aggregators, not part of the standard endpoint. [MTN-USE-CASES]
- `X-Reference-Id` must be a UUID v4 and unique; reusing a previous reference produces HTTP 409 with `RESOURCE_ALREADY_EXIST`. [MTN-ERRORS, MTN-BEST]
- MTN recommends generating `X-Reference-Id` server-side, persisting transaction state before initiating the MoMo request, never reusing one across different operations, and making retry logic idempotent. [MTN-BEST]
- `POST /requesttopay` is asynchronous. MTN's API description states HTTP 202 Accepted on valid request, with the resource initially `PENDING` and later `SUCCESSFUL` or `FAILED`. [MTN-AUTH]
- HTTP 202 is not success and must not trigger a wallet credit. MTN instructs integrators to poll for the final status and never assume immediate success. [MTN-BEST]
- Status is read via `GET /requesttopay/{X-Reference-Id}`; MTN names the corresponding Collection operation `RequesttoPayTransactionStatus`. [MTN-AUTH, MTN-USE-CASES]
- MTN states that every transaction has a corresponding Get Transaction Status endpoint and recommends exponential backoff, a maximum polling duration, and stopping once a terminal status is reached. [MTN-BEST]
- Note/message values over 160 characters are rejected; MTN points to its notification API for longer text. [MTN-ERRORS]
- Invalid currency must match the target environment; unsupported payer MSISDNs, insufficient funds and approval timeouts map to MTN error responses such as `PAYER_NOT_FOUND`, `INTERNAL_PROCESSING_ERROR` and `COULD_NOT_PERFORM_TRANSACTION`. [MTN-ERRORS]

### 3.4 Callback facts and documented conflict

- Request to Pay is asynchronous; if a callback URL is provided in the POST, MTN sends a callback when the request reaches a final `SUCCESSFUL` or `FAILED` state. [MTN-USE-CASES, MTN-CALLBACK]
- MTN states the callback is sent **only once**, with no retry; partners must use status polling as a fallback. [MTN-AUTH, MTN-CALLBACK, MTN-USE-CASES, MTN-BEST]
- The callback host must be registered as `providerCallbackHost` for the API user (sandbox provisioning API; production Account/Partner Portal). The callback URL host must match the configured host and be a hostname, not an IP address. [MTN-AUTH, MTN-CALLBACK, MTN-ERRORS]
- Only HTTPS callback URLs are allowed in sandbox and production. MTN's callback guidance also requires HTTPS on port 443, trusted CA certificates, and a prompt `200 OK`. [MTN-CALLBACK, MTN-BEST]
- Callback listeners are told to allow both `PUT` and `POST`. [MTN-AUTH, MTN-CALLBACK]
- **Conflict:** the API description says `PUT` is used by the Open API when sending callbacks, while the callback page's Deposit example says the callback will be a `POST` request and must be supplied in an `X-Callback-Url` header. The Collection-specific callback HTTP method and header name are therefore **UNVERIFIED** even though the general need to provide a callback URL is verified. [MTN-AUTH, MTN-CALLBACK]
- No cryptographic callback signature, signing secret, timestamp/nonce scheme or signed-header contract appears in the retrieved official MTN pages. Callback authentication beyond HTTPS, approved source IP ranges, registered callback host and transaction-reference validation is **UNVERIFIED**. [MTN-CALLBACK, MTN-BEST]
- MTN's best practice is to never blindly trust callback payloads, to validate source IPs from approved ranges, validate transaction reference identifiers, acknowledge quickly and process internally via a queue. It recommends a transaction-specific hash in a callback URL route parameter (not a query parameter). The approved IP ranges and the exact production callback contract were not published in the retrieved pages and are **UNVERIFIED**. [MTN-BEST]
- The existing synthetic HMAC in this repository is a test-namespace device and is **not** an MTN callback contract. It must never be reused as if it were provider verification. [Repository: `apps/api/src/payments/top-up-reconciliation.ts`]

## 4. Airtel Money: contract status

No authoritative Airtel contract detail was obtainable. The official developer portal URLs above returned transport errors; the official OpenAPI portal returned HTTP 401. No credentials were supplied or used, no auth bypass was attempted, and no provider API was called.

Consequently the following are all **UNVERIFIED** and implementation is deferred:

- OAuth/token endpoint, grant type, request and response fields, scope names and token lifetime;
- Collection endpoint, HTTP method, base URL, country/currency headers and request/response field names;
- Payer identifier format and Uganda-specific environment values;
- Callback delivery method, host registration, signature/verification algorithm, shared-secret rotation and replay rules;
- Provider idempotency key name, uniqueness scope and status semantics;
- Sandbox account/MSISDN fixtures and reconciliation/statement sources.

The repository's `apps/api/src/payments/payment-provider.contracts.ts` lists `clientId` and `clientSecret` as Airtel credential fields. Those are **repository configuration vocabulary only**, not verified provider contract facts. No Airtel adapter, token exchange, collection call or callback verifier should be written until the payment owner supplies authoritative documentation or approved onboarding material.

## 5. Gaps requiring payment owner confirmation

1. **MTN production API base URL and exact token URL.** MTN published the sandbox Collection example URL and the production profile host, but not a production Collection API base URL or a fully qualified token URL in the retrieved static pages.
2. **MTN callback method and callback URL header.** Resolve the `PUT` versus `POST` contradiction and confirm the Collection-specific callback URL field/header.
3. **MTN callback authentication.** Confirm whether the contracted integration supplies a cryptographic signature/header, or whether verification is limited to HTTPS, registered callback host, approved source IP ranges and transaction-reference checks. Obtain the approved source IP ranges if IP validation is required.
4. **MTN production target environment and currency.** Uganda `mtnuganda` is verified; confirm that UGX is enabled for the contracted merchant account and whether any environment-specific value differs from the public table.
5. **MTN account/onboarding specifics.** Confirm subscription key, API user, API key, callback hostname, IP whitelist and whether the merchant is an aggregator (the `transferType` field is only verified as an aggregator extension).
6. **MTN reconciliation source.** MTN recommends daily reconciliation and status polling, but the retrieved pages do not define a downloadable statement/report API or dispute workflow. Confirm the owned reconciliation artifact.
7. **All Airtel contract details.** Supply current official documentation or an approved provider contract covering authentication, collection, callbacks, idempotency, environments and reconciliation.
8. **Repository documentation conflict.** `docs/adr/0024-payment-provider-credential-configuration.md` states the payment-provider configuration migration is absent from `infrastructure/migrations-reviewed.json`, but the current manifest lists `20261030120000_payment_provider_configuration` at line 40. Do not infer deployment approval from that conflict; resolve it explicitly. The same manifest lists `20261107120000_payment_intent_foundation`, which is likewise not permission to execute a production migration.
9. **Activation authority.** Confirm who may activate a provider environment after contracts, credentials, migration review and tests are complete. No activation is authorized by this document.

## 6. Current repository implementation state

Inspected at commit `b0641cec63033748990f48d28d0c04b531be3081`:

- Platform payment-provider configuration exists for MTN and Airtel with encrypted-at-rest credentials, field-name-only redaction and a separate explicit activation action; it has no provider client and no live test connection. [ADR 0024; `apps/api/src/payments/payment-providers.service.ts`]
- Durable `TopUpRequest`, `PaymentIntent`, `PaymentAttempt`, `PaymentProviderEvent` and append-only `WalletEntry` models exist. [ADR 0012; `packages/database/prisma/schema.prisma`]
- Payment intent creation is organization-scoped and checks billing permission, with a unique `(organizationId, idempotencyKey)` constraint. [`apps/api/src/payments/prisma-payment-intents.store.ts`]
- The only settlement implementation is explicitly synthetic, unwired as a provider adapter, and reachable through a local-only `_test/payments/synthetic/*` controller guarded by test environment and test-operator checks. It uses a synthetic `HMAC-SHA256` callback signature namespace, not a provider contract. [`apps/api/src/payments/top-up-reconciliation.ts`; `top-up-integration.controller.ts`]
- No real MTN/Airtel client, HTTP adapter, token cache, callback listener, status poller, live reconciliation job or real wallet-credit path exists. [README; ADR 0024]

## 7. Proposed implementation sequence (all gated)

1. **Contract pack and decision.** Payment owner supplies the missing MTN production/token/callback facts and the full Airtel contract. Record an ADR that resolves the MTN callback contradiction and states exactly how each provider callback is authenticated. Do not write adapters before this step.
2. **Schema and migration review.** Reuse the existing payment-intent tables. Only add columns or tables that the confirmed contracts require (for example a verified callback header, source-IP allowlist reference or reconciliation batch identity), via a new reviewed additive migration. Review generated SQL, expand/contract compatibility, rollback and supervised execution; update `infrastructure/migrations-reviewed.json` only in a separate explicit approval. Never edit an applied migration or migration production data.
3. **Provider-neutral ports.** Define a narrow collection port in `packages/payments` with provider-agnostic money/party/result types. Put MTN and Airtel HTTP clients in provider-specific adapter directories with explicit mapping at the boundary. Keep provider SDKs and provider field names out of `@truevine/domain` and `@truevine/pricing`; use interfaces plus adapters and explicit `@Inject(TOKEN)` for all injected dependencies.
4. **Payment initiation.** Create the organization-scoped `PaymentIntent` in PostgreSQL first, then enqueue and call the adapter. Generate `X-Reference-Id` server-side as UUID v4 where MTN is used, persist it as the provider reference, and reuse the same key on every retry. Validate all amounts as integer minor units with explicit currency; never parse money from JSON floats. Treat HTTP 202 as accepted/pending only.
5. **Secure callback ingress.** Mount only after the contract is confirmed. Accept the verified MTN method(s), validate HTTPS/host/source/reference, verify the provider's documented authentication mechanism, store a redacted durable event row before acting, acknowledge promptly, and process asynchronously. Do not carry over the synthetic HMAC. Do not trust an unverified Airtel callback shape.
6. **Durable reconciliation.** Implement a job that polls the documented status endpoint with exponential backoff and a bounded horizon, plus a daily reconciliation process from the owner-confirmed source. Jobs are replay-safe and reconstructible from PostgreSQL; Redis/BullMQ holds work only. Record terminal status and discrepancy outcomes in `PaymentProviderEvent` without rewriting history.
7. **Idempotent wallet crediting.** In one PostgreSQL transaction, lock the intent, require a verified event and terminal success, assert amount/currency/organization match, insert at most one append-only `WalletEntry`, link the verified `PaymentAttempt`, and advance the intent status. Corrections use compensating entries. Never update or delete a ledger entry and never credit from a callback payload alone without the durable, verified event.
8. **Tests and activation gates.** Add Vitest unit tests with fakes for adapter mapping, auth caching, callback verification, replay, amount mismatch and cross-tenant denial; add disposable PostgreSQL E2E tests for uniqueness, concurrency and append-only ledger behavior. Only after migration approval, secret provisioning, successful gates and explicit owner authorization may an environment be activated. This task performs none of those actions.

## 8. Database, idempotency and ledger design aligned with AGENTS.md

- **Tenant scope:** every tenant-owned row is keyed/indexed by `organizationId`; organization identity comes from the authenticated session/path, never a client body field. Provider configurations remain platform-owned, as already decided in ADR 0024.
- **Idempotency:** reuse the existing `PaymentIntent.idempotencyKey` per organization. For MTN, persist the UUID v4 `X-Reference-Id` before the first provider call and reuse it on retry; the repository's existing unique `(organizationId, idempotencyKey)` and `(provider, environment, providerReference)` constraints prevent duplicate intents/attempts. Airtel's provider idempotency mechanism remains **UNVERIFIED**; no Airtel call is designed until confirmed.
- **Event durability:** write the provider event and its redacted payload in PostgreSQL before enqueueing work; keep `verified` and status projection fields, and deduplicate by the provider event identifier. The unique `(provider, environment, providerEventId)` constraint is the replay boundary. Do not store tokens, secrets or raw signed callback headers in event payloads.
- **Ledger:** `WalletEntry` remains append-only; its `SUM(amount_minor)` is the balance. Use the existing unique `(organizationId, paymentIntentId)` and `(organizationId, reference)` constraints as the one-credit guard. Store signed integer minor units and a three-letter currency code. Reject mismatched amount/currency into `RECONCILIATION_REQUIRED`; correct with a compensating entry, not an edit.
- **Queue discipline:** enqueue only after the database row commits, and make every enqueue safe to repeat. A flushed Redis must lose work, never a business fact.
- **Secrets:** use the existing encrypted-at-rest configuration and environment-provided encryption key. Do not print, log or commit provider values, tokens, callback secrets or connection strings.

## 9. Explicit non-actions

This change creates only this document. It does not add runtime code, migrations, dependencies, endpoints, credentials, activation state, provider SDKs, callback signatures, idempotency implementations, tests, deployments, merges or PRs to `main`. It does not call any live provider API or touch production data. All unverified details remain deferred.
