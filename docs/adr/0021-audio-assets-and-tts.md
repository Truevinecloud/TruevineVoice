# ADR 0021: private audio assets and TTS provider boundary

- **Status:** Proposed with W3-02; requires PR review before release.
- **Date:** 2026-10-24

## Context

W3-01's audio foundation is absent from main. Browser recordings and generated
speech need durable storage, organization isolation, usage attribution and
controlled playback. Audio can contain personal data, and TTS requests may incur
provider cost. The existing deployment has no configured object-storage or TTS
credentials.

## Decision

- Store audio bytes in a private S3-compatible bucket; store tenant-scoped
  metadata and usage in PostgreSQL. Never store bytes or public object URLs in
  audit metadata.
- Authorize playback through the API and return a short-lived signed URL. Use
  server-side encryption on uploaded objects.
- Define storage and TTS ports in `@truevine/audio`; provider SDK calls remain
  within `src/adapters/<provider>/`.
- Provide an S3-compatible storage adapter and an Amazon Polly adapter. Runtime
  configuration is optional for application boot but required to use those
  capabilities. Credentials come from the AWS SDK credential chain.
- Limit uploads to 10 MiB, supported audio container types, and five minutes
  where duration metadata is parseable. Validate MIME against the file bytes;
  never trust a browser-supplied duration for usage.
- Cap synchronous TTS scripts at 3,000 characters and require durable
  organization-scoped idempotency before calling the paid provider. Store only a
  request fingerprint and character count, never the script in audit events.
- Retain usage events append-only. Campaigns may refer only to an audio asset in
  the same organization; selection does not start calls or messages.

## Consequences

The first implementation depends on compatible S3 storage and Amazon Polly
runtime configuration. It can be tested with fake ports in unit tests; real
provider connectivity and authenticated production behavior require configured
credentials and live QA. Campaign execution remains outside this feature; the
campaign record selects the asset for a later execution path.

The Excel workplan was not available during implementation. Provider choice,
retention, maximum sizes and supported formats must be reconciled with its W3-01
and W3-02 rows when the workbook is provided.
