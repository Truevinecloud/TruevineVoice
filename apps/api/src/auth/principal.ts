/**
 * The authenticated caller, as the guards see them.
 *
 * Deliberately minimal. A `Principal` says *who* is calling; it says nothing
 * about which organization they are acting in, because that is a per-request
 * decision derived from a validated membership. Baking an organization into the
 * session would let a stale cookie act in a tenant the user has since left.
 */

import type { PlatformRole } from './prisma-types.js';

/** An authenticated caller. */
export interface Principal {
  readonly userId: string;
  readonly email: string;
  readonly sessionId: string;
  /** True once the platform-role lookup ran and found nothing. Never inferred. */
  readonly platformRole: PlatformRole | null;
}

/** The caller's standing in the organization named by the request path. */
export interface OrganizationContext {
  readonly organizationId: string;
  readonly role: import('./prisma-types.js').MembershipRole;
}

/** Verified support context kept separate from the real authenticated actor. */
export interface SupportAccessContext {
  readonly id: string;
  readonly organizationId: string;
  readonly actorUserId: string;
  readonly reasonCode: string;
  readonly expiresAt: Date;
}

/** Property name the session guard hangs the principal from. */
export const PRINCIPAL = 'principal';

/** Property name the organization guard hangs its context from. */
export const ORGANIZATION_CONTEXT = 'organizationContext';

/**
 * The request object once the guards have run.
 *
 * `headers` is declared rather than relying on an Express type: the guards read
 * cookies straight from the header rather than depending on a cookie-parser
 * middleware, because the only cookies that exist are two well-known names and a
 * parser would be a dependency with no other purpose.
 */
export interface AuthenticatedRequest {
  [PRINCIPAL]?: Principal;
  [ORGANIZATION_CONTEXT]?: OrganizationContext;
  supportAccessContext?: SupportAccessContext;
  /** Route parameters. */
  params?: Record<string, string>;
  /** Raw request headers, read directly rather than through a cookie parser. */
  headers?: Record<string, string | string[] | undefined>;
  method?: string;
  url?: string;
  /** Client address, when the adapter exposes it. */
  ip?: string;
}
