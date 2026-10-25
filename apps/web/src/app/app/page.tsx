import { redirect } from 'next/navigation';

import { fetchInvitations, fetchMembers, fetchOrganization } from '../../lib/org-api';
import { currentSession, hasPermission } from '../../lib/session';
import { EmptyState, PageHeader, SectionCard } from './AppUI';

/**
 * Organization dashboard. Shows actual organization data and points authorized
 * members to the billing journey; no invented usage or wallet figures.
 */
export default async function DashboardPage({
  searchParams,
}: {
  readonly searchParams: Promise<{ readonly organization?: string | string[] }>;
}): Promise<React.JSX.Element> {
  const session = await currentSession();

  if (!session.ok) redirect('/sign-in');

  const params = await searchParams;
  const requested = Array.isArray(params.organization)
    ? params.organization[0]
    : params.organization;

  const memberships = session.me.memberships;

  // Only ever fall back to a membership the caller actually holds. Reading an
  // organization id from the URL without checking it is the cross-tenant bug
  // this whole task exists to prevent.
  const membership =
    requested === undefined
      ? memberships[0]
      : memberships.find((entry) => entry.organizationId === requested);

  if (requested !== undefined && !membership) {
    return (
      <>
        <PageHeader title="Dashboard" description="Your organization workspace." />
        <p className="notice notice-error" role="alert">
          You do not have access to the selected organization.
        </p>
      </>
    );
  }

  if (!membership) {
    return (
      <>
        <PageHeader title="Welcome" description="Your Truevine Voice account is ready." />
        <SectionCard>
          <EmptyState title="No organization yet">
            Accept an invitation, or ask an organization owner to invite you.
          </EmptyState>
        </SectionCard>
      </>
    );
  }

  const [organization, members, invitations] = await Promise.all([
    fetchOrganization(membership.organizationId),
    hasPermission(membership, 'member:read')
      ? fetchMembers(membership.organizationId)
      : Promise.resolve(null),
    hasPermission(membership, 'invitation:read')
      ? fetchInvitations(membership.organizationId)
      : Promise.resolve(null),
  ]);

  const outstanding = invitations?.filter((invitation) => invitation.outstanding) ?? null;

  return (
    <>
      <PageHeader
        eyebrow="Organization workspace"
        title={organization?.name ?? membership.organizationName}
        description={`Signed in as ${membership.role.replace(/_/g, ' ').toLowerCase()} in this organization.`}
      />

      <SectionCard title="Team" description="People who have access to this organization.">
        {members === null ? (
          <p>You do not have permission to view members of this organization.</p>
        ) : (
          <p>
            {members.length} {members.length === 1 ? 'member' : 'members'}.{' '}
            <a href={`/app/team?organization=${encodeURIComponent(membership.organizationId)}`}>
              View the team
            </a>
          </p>
        )}
      </SectionCard>

      <SectionCard
        title="Pending invitations"
        description="Outstanding invitations for this organization."
      >
        {outstanding === null ? (
          <p>You do not have permission to view invitations for this organization.</p>
        ) : outstanding.length === 0 ? (
          <p>No invitations are waiting for a response.</p>
        ) : (
          <p>
            {outstanding.length} {outstanding.length === 1 ? 'invitation is' : 'invitations are'}{' '}
            waiting for a response.{' '}
            <a
              href={`/app/invitations?organization=${encodeURIComponent(membership.organizationId)}`}
            >
              Review them
            </a>
          </p>
        )}
      </SectionCard>

      <SectionCard
        title="Product status"
        description="Availability based on the current implementation."
      >
        <p>
          Contacts, campaigns, and billing appear in navigation only when your session grants the
          required organization permissions. Call history and campaign outcomes are not available
          yet; no activity metrics are fabricated.
        </p>
      </SectionCard>
    </>
  );
}
