/**
 * Server-side session handling.
 *
 * The session lives in an HTTP-only cookie set by the API. Nothing in this file
 * ever puts it into `localStorage`, `sessionStorage`, or any value that reaches a
 * client component: an HTTP-only cookie is the only reason an XSS payload cannot
 * exfiltrate the session, and reading it into JavaScript would give that capability
 * back.
 *
 * Next.js 16 makes `cookies()` asynchronous. Every read below awaits it.
 */

import { cookies } from 'next/headers';

import { apiRequest } from './api-target';
import type { OrganizationPermission, OrganizationRole } from '@truevine/auth';

/** Name of the API's session cookie. Mirrors `apps/api/src/auth/cookies.ts`. */
const SESSION_COOKIE = 'tv_session';

/** What `GET /me` returns. */
export interface MembershipSummary {
  readonly organizationId: string;
  readonly organizationSlug: string;
  readonly organizationName: string;
  readonly role: OrganizationRole;
  readonly permissions: readonly string[];
}

export interface Me {
  readonly userId: string;
  readonly email: string;
  readonly platformRole: string | null;
  readonly termsVersion: string;
  readonly termsAccepted: boolean;
  readonly memberships: readonly MembershipSummary[];
}

/** Why a caller could not be identified. Drives which screen is shown. */
export type SessionFailure =
  { readonly kind: 'signed_out' } | { readonly kind: 'expired' } | { readonly kind: 'revoked' };

export type SessionResult =
  { readonly ok: true; readonly me: Me } | { readonly ok: false; readonly failure: SessionFailure };

/**
 * Resolves the caller's session.
 *
 * Returns a discriminated result rather than throwing or redirecting, so a caller
 * can choose between "redirect to sign-in" and "render a 401 page" without
 * catching.
 */
export async function currentSession(): Promise<SessionResult> {
  const store = await cookies();

  // Read on the server only. The value is forwarded to the API and never returned
  // to the browser from here.
  const token = store.get(SESSION_COOKIE)?.value;

  if (!token) return { ok: false, failure: { kind: 'signed_out' } };

  let response: Response;

  try {
    response = await fetch(apiRequest('/me'), {
      headers: { cookie: `${SESSION_COOKIE}=${token}` },
      cache: 'no-store',
    });
  } catch {
    // The API being unreachable must not be reported as "signed out", which
    // would bounce a signed-in user to the sign-in screen during an outage.
    return { ok: false, failure: { kind: 'expired' } };
  }

  if (response.status === 401) {
    const body = (await response.json().catch(() => null)) as { error?: { code?: string } } | null;
    const code = body?.error?.code;

    if (code === 'session_expired') return { ok: false, failure: { kind: 'expired' } };
    if (code === 'session_revoked') return { ok: false, failure: { kind: 'revoked' } };

    return { ok: false, failure: { kind: 'signed_out' } };
  }

  if (!response.ok) return { ok: false, failure: { kind: 'signed_out' } };

  return { ok: true, me: (await response.json()) as Me };
}

/** The caller's memberships, or an empty list when signed out. */
export async function currentMemberships(): Promise<readonly MembershipSummary[]> {
  const session = await currentSession();

  return session.ok ? session.me.memberships : [];
}

/**
 * Whether the caller's role in `organizationId` holds `permission`.
 *
 * Presentational only. The API re-checks every request, so this decides what the
 * navigation *shows*, never what the user can *do*. Hiding a button is a courtesy
 * to the user, not a security control - AGENTS.md 4 says so explicitly.
 */
export function hasPermission(
  membership: MembershipSummary | undefined,
  permission: OrganizationPermission,
): boolean {
  return membership?.permissions.includes(permission) ?? false;
}

// Re-exported so a component imports one module rather than two. The registry in
// `@truevine/auth` is the single source of truth; duplicating the ladder here
// would be exactly the drift this project is built to avoid.
export { delegableRoles } from '@truevine/auth';
