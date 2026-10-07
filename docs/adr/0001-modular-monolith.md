# ADR 0001: Start as a modular monolith

- **Status:** Accepted
- **Date:** 2026-10-07

## Context

Truevine Voice is a multi-tenant automated customer engagement SaaS, starting
with outbound Voice in Uganda. The initial feature set is broad (voice
campaigns, contacts, messaging, wallet, billing) but the team is small and the
domain is still being designed.

Splitting into microservices now would force decisions about service
boundaries, distributed transactions, cross-service observability and
deployment pipelines before the domain model is even agreed.

## Decision

Build a modular monolith.

- One deployable database (PostgreSQL) and one transactional boundary.
- Code is separated into a workspace tree of `apps/*` and `packages/*` so that
  boundaries are enforced by the build, not by convention alone.
- `apps` may import `packages`. `packages` must never import `apps`.
- `@truevine/domain` and `@truevine/pricing` must never import provider SDKs.
- Controllers never contain direct business database queries; they delegate to
  services.
- Provider integrations live behind interfaces and adapters, so a provider can
  be replaced without touching domain logic.

## Consequences

**Positive**

- Local transactions across features; no distributed consistency problems.
- One deployment and one migration pipeline.
- Module boundaries are explicit in the repository structure, so extracting a
  service later is a mechanical exercise rather than an archaeological one.

**Negative**

- A single deployable unit means a bug in one module can affect the whole
  process.
- Discipline is required to keep modules from reaching into each other's
  internals; this is enforced by lint rules and code review, not by the runtime.

## Alternatives considered

- **Microservices from day one.** Rejected: premature, high coordination cost,
  and the domain boundaries are not yet known.
- **Single deployable app with no package structure.** Rejected: boundaries
  would be implicit and unenforceable.
