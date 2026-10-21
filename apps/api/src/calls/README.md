# Internal call persistence

This directory owns contact persistence, immutable campaign recipients,
provider-neutral call acceptance and event history. It exposes no HTTP routes
and is not registered in AppModule. Internal callers must supply an authorized
organization. CallPersistence uses narrow structural SQL transaction interfaces;
the composition root retains ownership of Prisma and shutdown.

See ADR 0018 for business execution identity, explicit redials, fingerprint
versioning and database constraints. call.accept records acceptance only: its
replay result remains QUEUED even when the current attempt has advanced.
recordEvent returns a privacy-safe conflict diagnostic after commit; call_events
is the durable audit source. No logging hook can break a committed transaction.

No provider, queue execution, charging or wallet changes are implemented.
Run npm run test:call-persistence:e2e against an explicitly disposable PostgreSQL
database with NODE_ENV=test and CALL_PERSISTENCE_DISPOSABLE=1 (or CI=true).
