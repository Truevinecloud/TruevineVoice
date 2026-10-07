# AGENTS.md — instructions for coding agents working on Truevine Voice

This file is binding on any automated coding agent (and a useful review
checklist for humans) working in this repository. It records rules that must
hold across every change.

If a task appears to require breaking one of these rules, stop and raise it
rather than working around it.

---

## 1. Inspect before editing

Never start from assumptions.

1. Read `README.md` and this file first.
2. Find the code that already owns the behaviour you are about to change.
   `grep`/`glob` before writing new code.
3. Read the existing tests. They encode decisions that are not written down
   anywhere else.
4. Check `docs/adr/` for a decision that already covers your change.
5. Only then edit.

If you find code that contradicts this file, do not silently "fix" it. Report
the conflict and let the decision be made explicitly.

## 2. Architecture boundaries

Truevine Voice is a **modular monolith**. Do not introduce microservices, and do
not split a feature across processes without an explicit instruction.

The dependency direction is strictly one-way:

```
apps/web      apps/api     apps/worker     apps/admin
     \            |             |            /
      \           |             |           /
       +----->  packages/*  <--------+
```

- `apps` may depend on `packages`.
- **`packages` must never depend on `apps`.** Not for types, not for tests, not
  "just this once".
- `@truevine/domain` and `@truevine/pricing` **must never import provider
  SDKs**. No Africa's Talking, no payment provider, no carrier client. If domain
  logic needs something from a provider, it needs an interface.
- Providers are reached only through interfaces plus adapters. Adapters live in
  `packages/telephony/src/adapters/<provider>/` or equivalent, and nothing else
  imports from inside an adapter directory.

## 3. Layer responsibilities

- **Controllers** own HTTP: routing, status codes, serialisation. They must not
  contain business database queries. `HealthController` is the reference: it
  calls a service and maps the result onto a status code.
- **Services** own business decisions and orchestration.
- **Packages** own reusable, framework-agnostic logic. A package that imports
  NestJS is doing something unusual — justify it.
- Cross-module access goes through exported providers, never by reaching into
  another module's files.

## 3a. Module system and dependency injection

- Every Node workspace (`apps/api`, `apps/worker`, `packages/*`) is an ES
  module: `"type": "module"` with `nodenext` resolution, because NestJS 12 is
  published ESM-only.
- **Relative imports in Node workspaces must carry an explicit `.js`
  extension.** The Next.js apps are the exception and use extensionless imports,
  because Turbopack does not remap `.js` onto TypeScript sources.
- **Every constructor-injected dependency declares an explicit
  `@Inject(TOKEN)`.** Dependency injection must never depend on
  `emitDecoratorMetadata`, because the test runner uses Vitest's built-in
  transform, which does not emit it. A constructor parameter without
  `@Inject(...)` will work in `nest build` and fail in tests — that is the bug
  this rule prevents.
- Infrastructure clients are injected through narrow structural interfaces
  (`QueryableClient`, `PingableClient`), never through the concrete Prisma or
  ioredis types. That is what lets unit tests run without Docker.
- Test fakes must satisfy the **whole** lifecycle contract of what they
  replace, including shutdown methods such as `$disconnect()` and
  `disconnect()`. A partial fake makes application shutdown throw.

## 4. Implement only the requested scope

- Do exactly what was asked, at the quality bar a production codebase expects.
  Do not implement adjacent features "while you are here".
- Do not add speculative abstractions, extension points, generic base classes or
  configuration flags for requirements that do not exist yet.
- Do not add dependencies without a stated need. If a dependency is genuinely
  required, say why in the pull-request description.
- Do not create empty scaffolding to match a future directory tree. If a package
  must exist, a `package.json` plus a `README.md` explaining what belongs there
  and why it is empty is enough.
- Do not implement deferred features without explicit instruction: contacts,
  campaigns, audio, wallet, billing, voice, SMS, WhatsApp, RBAC,
  authentication, admin functionality.

## 5. Tenant isolation

- Every piece of tenant-owned data is organization-scoped. No exceptions.
- Organization identity comes from the authenticated session or the path, never
  from a client-supplied body or query field that is trusted as-is.
- Enforce scope in the **database** (composite indexes, foreign keys, and where
  appropriate row-level security), not only in application code. Application
  checks are the first line of defence, not the only one.
- A query that cannot state which organization it belongs to is a bug, even if
  it currently returns nothing.

## 6. Money

- **Never use JavaScript floating-point numbers for money.** `0.1 + 0.2 !== 0.3`.
- Represent amounts as integer minor units with an explicit currency code
  (e.g. `{ amountMinor: 5000, currency: 'UGX' }`), or an exact decimal type
  where sub-unit precision is genuinely required.
- Currency is part of the value. An amount without a currency is incomplete.
- Round once, in one documented place, with a stated rounding mode.
- Never derive a chargeable amount from a float that came off the wire.

## 7. Wallet accounting is an immutable ledger

- Entries are **append-only**. Never update or delete a ledger entry.
- A balance is a **projection**: the sum of entries, always recomputable.
- Corrections are made with compensating entries, never by editing history.
- The ledger is the audit trail. If something cannot be expressed as a ledger
  entry, it is not a financial event.

## 8. Provider abstraction

- Africa's Talking will be the first Voice adapter. It is not implemented yet
  and must not be implemented speculatively.
- Domain and pricing code depends on interfaces, never on an SDK.
- Provider webhook payloads are untrusted input: validate the shape, verify the
  signature, and record the event before acting on it.
- Provider responses are not our data model. Map them explicitly at the adapter
  boundary; never let a provider's field names leak into domain types.

## 9. Idempotency

- Any external paid operation (placing a call, sending a message, charging a
  card, debiting a wallet) is wrapped in an idempotency operation.
- The idempotency key is durable: stored in PostgreSQL with a uniqueness
  constraint, never only in Redis or in process memory.
- A retry must reuse the original key. Generating a fresh key on retry is a
  double-charge bug.
- Concurrent requests with the same key must not both perform the side effect.
- Any enqueue must also be safe to repeat.

## 10. PostgreSQL and Redis

- PostgreSQL is the **system of record**. Redis/BullMQ carries asynchronous
  work and coordination state only.
- Write the database row first, then enqueue the job to act on it. A job payload
  is never the only copy of a business fact.
- If Redis is flushed, the system must recover from PostgreSQL alone.

## 11. Secrets

- Secrets never enter the repository. No credentials, keys, tokens, connection
  strings or `.env` files are ever committed.
- `.env` is gitignored. `.env.example` contains safe placeholders only.
- Read secrets from the environment at start-up, validate them, and fail the
  boot if they are missing. Never fall back to a hard-coded default secret.
- Never log a secret. Health probes report connection failures without echoing
  the connection string.

## 12. Migrations

- Never hand-edit a migration that has already been applied anywhere.
- Never drop or reset a database that holds data you did not create.
- Keep schema changes backward compatible with the currently deployed version
  (expand/contract), so deploys and migrations can happen independently.
- Review generated SQL before applying it outside a disposable environment.
- `prisma migrate deploy` is for controlled environments only. Never run it
  against production by hand.

## 13. Tests

- Behaviour changes require tests. A change that alters observable behaviour
  without a test is incomplete.
- Match the existing test style: Vitest, `*.spec.ts` next to the code for unit
  tests, `test/*.e2e-spec.ts` for end-to-end tests.
- Unit tests must not require PostgreSQL or Redis. Inject fakes through the same
  injection tokens production uses.
- End-to-end tests **may** require infrastructure and must fail loudly when it is
  missing. Do not add silent skips to make a suite pass.
- Tests assert on behaviour and contracts, not on implementation details.

## 14. Never bypass a failure

- **Never** delete, skip, `xit`, comment out or weaken a failing test to make a
  build or pipeline green. Fix the cause or report the failure.
- **Never** suppress errors, silence type checks, lower compiler strictness or
  add `@ts-ignore` to get past a build. Every suppression is a decision that
  must be explained in the report.
- **Never** relax a lint rule globally to silence one new violation.
- If something genuinely cannot pass right now, leave it failing and say so
  clearly. A red build you reported is more useful than a green build you hid.

## 15. Never edit production data directly

- No `psql` updates, no manual row edits, no ad-hoc SQL against any
  non-disposable database.
- Data changes happen through application code with a migration or an audited
  script that is idempotent and reviewed.
- Corrections to financial records go through compensating ledger entries.

## 16. Reporting

Every task ends with an explicit report containing:

1. **Files created or changed**, as a list of paths.
2. **Commands executed**, in order, with their outcome.
3. **Verification performed**: which lint, typecheck, test and build commands ran,
   and their results.
4. **Failures and warnings**, reported honestly. Never claim success for
   something that did not run or did not pass.
5. **Deferred work**: what was deliberately not implemented, and why.

Do not commit or push unless explicitly asked. Never rewrite Git history.

## 17. Repository hygiene

- Keep `package.json` scripts as the single entry point for developer commands.
  If a new command is needed, add it to the root `package.json` so the README
  stays accurate.
- Update `README.md` when setup steps or commands change.
- Write an ADR in `docs/adr/` for any hard-to-reverse, cross-cutting decision.
- Keep `.gitignore` accurate; commit nothing that should have been ignored.
- Prefer exact dependency versions (`save-exact=true` is already configured).
  Upgrade deliberately, in a dedicated change.

---

## Quick checklist before declaring a task done

- [ ] Inspected existing code and tests before editing.
- [ ] No `apps` → `packages` inversion; no provider SDK in domain or pricing.
- [ ] No direct database query in a controller.
- [ ] Tenant-owned data organization-scoped.
- [ ] No floating-point money.
- [ ] Any financial event expressed as an append-only ledger entry.
- [ ] External paid operation has an idempotency key.
- [ ] No secrets committed; no secret logged.
- [ ] Tests added for behaviour changes.
- [ ] No test skipped or weakened to pass.
- [ ] `lint`, `typecheck`, `test`, `build` run and reported honestly.
- [ ] Nothing deferred was implemented "while I was in there".
- [ ] README/ADR updated if commands or decisions changed.
