/**
 * Server-side reads of organization data.
 *
 * Every call forwards the caller's session cookie to the API, which re-checks
 * membership and permission. Nothing here decides access; it only relays.
 *
 * Reads are `cache: 'no-store'`. A cached organization profile would show one
 * member a name another member just changed, and would keep rendering a page for
 * a session that has since been revoked.
 */

import { cookies } from 'next/headers';

import { apiRequest } from './api-target';

const SESSION_COOKIE = 'tv_session';

/** An organization profile. */
export interface Organization {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
}

/** A member as the API returns it. Never includes the password hash. */
export interface Member {
  readonly userId: string;
  readonly email: string;
  readonly role: string;
  readonly joinedAt: string;
}

/** An invitation. Never includes the token. */
export interface Invitation {
  readonly id: string;
  readonly email: string;
  readonly role: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly acceptedAt: string | null;
  readonly revokedAt: string | null;
  readonly outstanding: boolean;
}

/**
 * Read-only campaign fields available to organization campaign readers.
 *
 * `PAUSED` is a record the API reports for an emergency-stopped campaign. It is
 * a status of the record, not evidence that any call was placed.
 */
export interface Campaign {
  readonly id: string;
  readonly name: string;
  readonly status: 'DRAFT' | 'ACTIVE' | 'COMPLETED' | 'PAUSED';
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly audioAssetId?: string | null;
  readonly scheduledAt?: string | null;
  readonly retryMaxAttempts?: number;
  readonly retryDelayMinutes?: number;
  readonly audienceGroupIds?: readonly string[];
}

export interface CampaignStatusReport {
  readonly total: number;
  readonly draft: number;
  readonly active: number;
  readonly completed: number;
}

/** Forwards the session cookie to the API. */
async function authorizedFetch(path: string): Promise<Response> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;

  if (!token) {
    return new Response(JSON.stringify({ error: { code: 'unauthenticated' } }), { status: 401 });
  }

  return fetch(apiRequest(path), {
    headers: { cookie: `${SESSION_COOKIE}=${token}` },
    cache: 'no-store',
  });
}

/**
 * Fetches JSON, or returns `null` when the caller may not see it.
 *
 * A `null` is not swallowed here. Each caller renders an explicit "not available"
 * or redirects, because silently showing an empty list looks like "this
 * organization has no members" and is a different statement entirely.
 */
async function readJson<T>(path: string): Promise<T | null> {
  const response = await authorizedFetch(path);

  if (!response.ok) return null;

  return (await response.json()) as T;
}

export async function fetchOrganization(organizationId: string): Promise<Organization | null> {
  return readJson<Organization>(`/organizations/${organizationId}`);
}

export async function fetchMembers(organizationId: string): Promise<readonly Member[] | null> {
  return readJson<readonly Member[]>(`/organizations/${organizationId}/members`);
}

export async function fetchInvitations(
  organizationId: string,
): Promise<readonly Invitation[] | null> {
  return readJson<readonly Invitation[]>(`/organizations/${organizationId}/invitations`);
}

export async function fetchCampaigns(organizationId: string): Promise<readonly Campaign[] | null> {
  return readJson<readonly Campaign[]>(`/organizations/${organizationId}/campaigns`);
}

export async function fetchCampaignStatusReport(
  organizationId: string,
): Promise<CampaignStatusReport | null> {
  return readJson<CampaignStatusReport>(`/organizations/${organizationId}/reports/campaign-status`);
}

/** Whether the caller may read a resource, for rendering a refusal rather than a 404. */
export async function canRead(path: string): Promise<boolean> {
  const response = await authorizedFetch(path);

  return response.ok;
}
