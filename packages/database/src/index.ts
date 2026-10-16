/**
 * PostgreSQL access for Truevine Voice.
 *
 * This module is deliberately framework-agnostic: it has no dependency on
 * NestJS or on any HTTP layer, so every app can create a client the same way
 * and the package stays reusable.
 *
 * Tenant-isolation reminder: `OrganizationTenantClient` is a placeholder for
 * the future organisation-scoped accessor. It intentionally exposes no
 * un-scoped model access today because there are no models yet. When models
 * are introduced, every read and write issued through it must be constrained to
 * a single `organizationId`, and that constraint must be enforced by the
 * database as well as by the application.
 */

import { PrismaPg } from '@prisma/adapter-pg';
import { describeError, elapsedMs, withTimeout, type DependencyHealth } from '@truevine/shared';

import { PrismaClient } from './generated/prisma/client.js';

export { PrismaPg };
export type { PrismaClient };

/**
 * The database's enum vocabularies, as types only.
 *
 * Re-exported so an application can name `MembershipRole` without reaching into
 * the generated client directory, which is an implementation detail of this
 * package. Type-only on purpose: importing the runtime enum objects would drag
 * the generated client into any consumer, including a browser bundle.
 */
export type {
  AuditOutcome,
  AuditScope,
  MembershipRole,
  PlatformRole,
  UserStatus,
} from './generated/prisma/client.js';

/** Default per-probe timeout for infrastructure health checks. */
export const DEFAULT_DATABASE_PROBE_TIMEOUT_MS = 2_000;

/**
 * The minimal surface a health probe needs from a database client.
 *
 * Declared structurally so that probes can be unit tested with a fake and so
 * that callers are not forced to accept the full Prisma client surface.
 */
export interface QueryableClient {
  $queryRaw(strings: TemplateStringsArray, ...values: readonly unknown[]): Promise<unknown>;
}

/**
 * Creates a Prisma client bound to `connectionString`.
 *
 * Prisma 7 executes through driver adapters; `@prisma/adapter-pg` brings its
 * own `pg` dependency, so nothing else needs to be installed here.
 */
export function createDatabaseClient(connectionString: string): PrismaClient {
  return new PrismaClient({
    adapter: new PrismaPg({ connectionString }),
    log: process.env['LOG_LEVEL'] === 'debug' ? ['warn', 'error'] : ['error'],
  });
}

/**
 * Probes PostgreSQL connectivity.
 *
 * Uses `SELECT 1`, so it works before any table exists. Failures are captured
 * and returned rather than thrown: a health endpoint must always answer with a
 * report describing the outage instead of crashing.
 */
export async function probeDatabase(
  client: QueryableClient,
  timeoutMs: number = DEFAULT_DATABASE_PROBE_TIMEOUT_MS,
): Promise<DependencyHealth> {
  const startedAt = Date.now();
  try {
    await withTimeout(client.$queryRaw`SELECT 1`, timeoutMs);
    return { status: 'up', latencyMs: elapsedMs(startedAt) };
  } catch (error) {
    return {
      status: 'down',
      latencyMs: elapsedMs(startedAt),
      error: describeError(error),
    };
  }
}

/**
 * Future organisation-scoped database accessor.
 *
 * Intentionally inert. It exists as an architectural anchor: application
 * services are expected to obtain tenant-scoped access through a seam like
 * this one rather than constructing raw clients ad hoc, which keeps tenant
 * isolation auditable in one place.
 */
export class OrganizationTenantClient {
  readonly #client: PrismaClient;
  readonly #organizationId: string;

  constructor(client: PrismaClient, organizationId: string) {
    if (organizationId.trim().length === 0) {
      throw new Error('OrganizationTenantClient requires a non-empty organizationId.');
    }
    this.#client = client;
    this.#organizationId = organizationId;
  }

  /** Identifier of the organization this accessor is bound to. */
  get organizationId(): string {
    return this.#organizationId;
  }

  /** The underlying Prisma client. Not exposed as queries until models exist. */
  get client(): PrismaClient {
    return this.#client;
  }
}
