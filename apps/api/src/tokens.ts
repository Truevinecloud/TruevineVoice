/**
 * Injection tokens for infrastructure clients.
 *
 * Declared as symbols so that the infrastructure client types (Prisma, ioredis)
 * never leak into the Nest metadata of application services. Consumers inject
 * narrow structural interfaces instead, which keeps services testable without
 * a live database or Redis.
 */

/** A Prisma client instance, provided by {@link InfrastructureModule}. */
export const DATABASE_CLIENT = Symbol('DATABASE_CLIENT');

/** An ioredis client instance, provided by {@link InfrastructureModule}. */
export const REDIS_CLIENT = Symbol('REDIS_CLIENT');
