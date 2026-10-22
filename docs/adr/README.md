# Truevine Voice - architecture decision records

Each file in this directory records one architectural decision in the format
recommended by Michael Nygard's ADR process.

Naming: `NNNN-short-kebab-title.md`, numbered sequentially and never reused.

## Index

| #                                                                 | Decision                                             | Status                                                    |
| ----------------------------------------------------------------- | ---------------------------------------------------- | --------------------------------------------------------- |
| [0001](./0001-modular-monolith.md)                                | Start as a modular monolith                          | Accepted                                                  |
| [0002](./0002-runtime-and-toolchain-versions.md)                  | Node, TypeScript and framework version policy        | Accepted                                                  |
| [0003](./0003-postgresql-system-of-record.md)                     | PostgreSQL is the system of record; Redis is not     | Accepted                                                  |
| [0004](./0004-github-actions-ci.md)                               | CI E2E tests run the real Compose stack              | Accepted                                                  |
| [0005](./0005-production-deployment.md)                           | CI-gated release directories and PM2 deployment      | Accepted; VPS adoption pending                            |
| [0006](./0006-tenancy-core-schema.md)                             | Tenancy enforced by composite keys, not queries      | Accepted                                                  |
| [0011](./0011-reviewed-deployment-migrations.md)                  | Apply reviewed migrations before activation          | Accepted                                                  |
| [0012](./0012-customer-billing-ledger.md)                         | Customer billing ledger and pending top-up requests  | Proposed                                                  |
| [0013](./0013-platform-operations-admin.md)                       | Platform Operations Admin emergency stops            | Accepted for implementation                               |
| [0014](./0014-first-platform-owner-bootstrap.md)                  | Audited singleton first Platform Owner bootstrap     | Local implementation; production approval withheld        |
| [0015](./0015-read-only-technical-admin.md)                       | Read-only Technical Admin platform role              | Accepted for implementation; production approval withheld |
| [0016](./0016-read-only-auditor.md)                               | Read-only Auditor platform role                      | Accepted for implementation; production approval withheld |
| [0017](./0017-provider-neutral-telephony-port-and-call-domain.md) | Provider-neutral telephony port and pure call domain | Accepted for implementation                               |

## When to write an ADR

Write one when a decision is hard to reverse, affects more than one workspace,
or would be surprising to a future reader without context. Do not write one for
routine implementation choices.

- [0018: Call recipient persistence and durable idempotency](0018-call-recipient-persistence-and-idempotency.md)

- [0019: Tenant isolation write authorization](0019-tenant-isolation-write-authorization.md)

- [0020: Sensitive action audit](0020-sensitive-action-audit.md)

- [0021: Controlled support access](0021-controlled-support-access.md)
