# ADR 0003: PostgreSQL is the system of record

- **Status:** Accepted
- **Date:** 2026-10-07

## Context

Truevine Voice uses PostgreSQL, Redis and BullMQ. In a system that moves money,
the choice of which store is authoritative determines what happens during
incidents.

## Decision

**PostgreSQL is the system of record.**

- Anything that must survive a restart, a flush or a failover lives in
  PostgreSQL.
- Redis is a transport and coordination layer: job payloads, BullMQ queue
  state, locks and caches. Losing Redis loses _work in flight_, never a
  business fact.
- BullMQ queue state is therefore always reconstructible from PostgreSQL. A job
  payload must never be the only copy of a piece of business data.
- Enqueue is never the only record that something happened: the database row is
  written first, and the job is enqueued to act on it.

### Consequences for tenant isolation

Every future tenant-owned table is organization-scoped. That means an
`organizationId` column, an index that leads with it, and a database-level
constraint, so cross-tenant access is prevented by the database rather than
merely avoided by application code. The `@truevine/database` package exposes an
organization-scoped accessor (`OrganizationTenantClient`) as the intended seam.

### Consequences for money

Wallet balances are **not** a mutable column. They are derived from an
**immutable ledger**: entries are appended only, never updated or deleted, and
corrections are made with compensating entries. A balance is a projection that
can always be rebuilt and audited.

### Consequences for external operations

Any operation that costs money or otherwise has a side effect outside our system
is wrapped in an idempotency operation with a durable idempotency key stored in
PostgreSQL. Retries are safe; a replayed request cannot double-charge a customer
or place a second provider call.

## Consequences

- The database becomes the thing that must be operated well: backups, point-in-
  time recovery, and tested restore procedures are prerequisites for production.
- Adding Redis persistence (AOF) improves recovery time but never changes the
  fact that PostgreSQL remains authoritative.
