/**
 * Injection tokens for the authentication layer.
 *
 * Symbols, like `apps/api/src/tokens.ts`, so that neither the generated Prisma
 * client nor the concrete store implementations leak into Nest's metadata. Unit
 * tests inject fakes through these same tokens, which is why the fast suite
 * never needs a database.
 *
 * The persistence interfaces are re-exported so a consumer - a unit test, or a
 * future module - can implement a fake with a single import. Nothing else
 * re-exports them.
 */
export type {
  AuditStore,
  AuthStore,
  OrganizationStore,
  PlatformRoleStore,
  ProvisioningStore,
} from './auth.store.js';

/** {@link AuthStore} implementation. */
export const AUTH_STORE = Symbol('AUTH_STORE');

/** {@link OrganizationStore} implementation. */
export const ORGANIZATION_STORE = Symbol('ORGANIZATION_STORE');

/** {@link PlatformRoleStore} implementation. */
export const PLATFORM_ROLE_STORE = Symbol('PLATFORM_ROLE_STORE');

/** {@link AuditStore} implementation. */
export const AUDIT_STORE = Symbol('AUDIT_STORE');

/** {@link ProvisioningStore} implementation, used by the operator CLI only. */
export const PROVISIONING_STORE = Symbol('PROVISIONING_STORE');

/** Minimum milliseconds between password-reset requests for one account. */
export const PASSWORD_RESET_COOLDOWN_MS = Symbol('PASSWORD_RESET_COOLDOWN_MS');

/** The terms version a user must have accepted to use the application. */
export const TERMS_VERSION = Symbol('TERMS_VERSION');

/** Consecutive failed sign-ins before an account is locked. */
export const SIGN_IN_FAILURE_LIMIT = Symbol('SIGN_IN_FAILURE_LIMIT');

/** How long a sign-in lockout lasts. */
export const SIGN_IN_LOCKOUT_MS = Symbol('SIGN_IN_LOCKOUT_MS');

/** The {@link RateLimiter} implementation. */
export const RATE_LIMITER = Symbol('RATE_LIMITER');
