import type { MembershipSummary } from './session';

/** A URL selects a membership; it never creates authority or an implicit fallback. */
export function selectMembership(
  memberships: readonly MembershipSummary[],
  requested: string | readonly string[] | null | undefined,
): MembershipSummary | undefined {
  const available = memberships.filter((entry) => entry.organizationStatus !== 'SUSPENDED');
  if (requested === undefined || requested === null) return available[0];
  if (Array.isArray(requested)) {
    return requested.length === 1
      ? available.find((entry) => entry.organizationId === requested[0])
      : undefined;
  }
  return available.find((entry) => entry.organizationId === requested);
}
