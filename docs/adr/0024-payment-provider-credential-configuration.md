# 0024 — Payment-provider credential configuration

Status: Proposed implementation; not approved for production deployment. The
migration is deliberately absent from `infrastructure/migrations-reviewed.json`.

## Context

Truevine needs to take mobile-money payments through MTN Mobile Money and Airtel
Money. Both providers issue environment-specific credentials (sandbox and
production are separate accounts with separate secrets), and nothing in the
repository stores them today. There is no provider client, no webhook handler
and no payment path.

The configuration surface must be usable by a platform Super Admin without ever
returning a stored secret, without logging one, and without a save quietly going
live. The two providers do not share a credential contract, so a single
free-form JSON blob would let one provider's field names leak into the other.

## Decision

### Platform-owned, not tenant-owned

`payment_provider_configurations` has no `organization_id`. A payment-provider
account belongs to Truevine, and no customer-facing route may reach it. The new
permissions `platform:payments:read` and `platform:payments:configure` are held
by `PLATFORM_OWNER` alone. Support, technical, billing and auditor roles cannot
read credential presence or replace a secret.

The admin application exposes this as Super Admin → Settings → Payment
integrations (`/settings/payments`). The Next.js proxy allowlist includes only the
reviewed payment routes.

### Credentials are encrypted at rest with no default key

A credential set is serialized and encrypted with AES-256-GCM into a single
envelope (`v1.<iv>.<tag>.<ciphertext>`) in `credentials_ciphertext`. The
additional authenticated data is `v1|<provider>|<environment>`, so copying a row
to another provider or environment fails authentication rather than decrypting
the wrong secret.

The key comes from `PAYMENT_CREDENTIAL_ENCRYPTION_KEY`, must decode to exactly 32
bytes, and has no fallback. It is required in production; when it is absent in
development or test, credential writes return `503` and no row is written. The
key is never stored in PostgreSQL, returned by an endpoint or written to an audit
event.

### The API returns presence, never values

`credential_fields` stores field **names** only. The list and detail responses
describe each configured field as present or absent, with its label, plus the
callback URL and timestamps. There is no endpoint that returns a decrypted
credential. The callback URL is configuration, not a secret, but it is also kept
out of the audit trail and is restricted to HTTPS with no credentials, query
string or fragment.

### Saving does not activate

`active` defaults to `false`. Activation is a separate, explicitly confirmed
request. The service and the database both require an encrypted credential set
and a callback URL before activation:

- a CHECK constraint enforces credential presence and the activation timestamps;
- a partial unique index permits at most one active environment per provider;
- an active row refuses credential updates until it is deactivated.

Switching environments is therefore deactivate-then-activate, and it is recorded
as two events rather than one silent overwrite.

### No connection test, because there is nothing to test with

No reviewed MTN or Airtel client is linked in this build. The UI renders
**Test connection disabled** with an explanation, and the API exposes no test
route. Returning a canned success would be a false statement about whether
payments can be taken, which is worse than an honest gap.

### Audit

Every read writes `platform.payment_provider.configurations_viewed` or
`platform.payment_provider.configuration_viewed`. Every mutation writes
`configured`, `activated` or `deactivated` in the same PostgreSQL transaction as
the row change. Metadata contains the provider, environment, changed field
**names**, callback presence and version — never a value, an envelope or the
callback URL itself.

## Consequences

- Provider field contracts live in one module
  (`apps/api/src/payments/payment-provider.contracts.ts`). Adding a provider is a
  reviewed migration and a contract change, not a data edit.
- Losing or rotating the encryption key makes existing ciphertext unreadable.
  A reviewed re-encryption procedure is required before rotation and is not
  implemented.
- The audit trail records that a credential set changed, but cannot reconstruct
  the previous secret. Corrections are new saves, not history edits.
- Tests cover the cipher (round trip, AAD binding, tamper detection, key
  required), service validation and activation safeguards, HTTP authorization
  and redaction, proxy forwarding, and the admin UI's disabled/confirmation and
  loading/error states. They use in-memory fakes and real guards; they do not
  prove the migration applies cleanly to PostgreSQL.

## Deployment prerequisites

1. Review the generated SQL in
   `packages/database/prisma/migrations/20261030120000_payment_provider_configuration`
   for generated SQL, expand/contract compatibility, rollback and a supervised
   execution plan, then add it to `infrastructure/migrations-reviewed.json` in a
   separate reviewed change. Until then deployment is blocked by design. The
   review materials are in
   [`docs/migrations-payment-provider-review-2026-10-30.md`](../migrations-payment-provider-review-2026-10-30.md).
2. Provision `PAYMENT_CREDENTIAL_ENCRYPTION_KEY` in the deployment secret
   manager before starting an API that serves configuration writes.
3. Apply the migration in a controlled environment with `prisma migrate deploy`;
   it is additive and safe while the table is empty. The rollback is
   `DROP TABLE payment_provider_configurations` plus the two enum types, and it
   becomes forward-only once credentials exist.
4. Obtain real MTN and Airtel credentials through each provider's onboarding
   process. Do not invent, share or commit test credentials.

## Deliberately not implemented

No live payment collection, wallet crediting, provider callback endpoint,
webhook signature verification, reconciliation, refunds, connection test,
credential rotation, or provider client. Those are separate reviewed changes.
