# Database package

Prisma schema, client construction and PostgreSQL health/access helpers.
Call-persistence tables and custom SQL integrity rules are documented in
[ADR 0018](../../docs/adr/0018-call-recipient-persistence-and-idempotency.md).
Tenant-owned references use composite organization keys. Do not regenerate away
migration checks, append-only triggers or immutable snapshot guards.
New migrations require separate production SQL review and authorization.
