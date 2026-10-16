import { redirect } from 'next/navigation';

import { fetchInvitations, fetchMembers, fetchOrganization } from '../../lib/org-api';
import { currentSession, hasPermission } from '../../lib/session';

/**
 * Organization Owner dashboard.
 *
 * Shows what is real. Campaigns, call volumes and billing do not exist yet, so
 * this screen does not draw placeholder cards for them - a dashboard full of
 * invented numbers is worse than an empty one, because it teaches a reader what
 * the product is supposed to look like.
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
    memberships.find((entry) => entry.organizationId === requested) ?? memberships[0];

  if (!membership) {
    return (
      <>
        <h1 className="page-title">Welcome</h1>
        <div className="card-section">
          <h2>No organization yet</h2>
          <p>
            Your account is not a member of any organization. Accept an invitation, or ask an
            organization owner to invite you.
          </p>
        </div>
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
      <h1 className="page-title">{organization?.name ?? membership.organizationName}</h1>
      <p style={{ color: '#5b6472', marginTop: '-0.5rem' }}>
        You are signed in as {membership.role.replace(/_/g, ' ').toLowerCase()} in this
        organization.
      </p>

      <div className="card-section">
        <h2>Team</h2>
        {members === null ? (
          <p>You do not have permission to view members of this organization.</p>
        ) : (
          <p>
            {members.length} {members.length === 1 ? 'member' : 'members'}.{' '}
            <a href="/app/team">View the team</a>
          </p>
        )}
      </div>

      <div className="card-section">
        <h2>Pending invitations</h2>
        {outstanding === null ? (
          <p>You do not have permission to view invitations for this organization.</p>
        ) : outstanding.length === 0 ? (
          <p>No invitations are waiting for a response.</p>
        ) : (
          <p>
            {outstanding.length} {outstanding.length === 1 ? 'invitation is' : 'invitations are'}{' '}
            waiting for a response. <a href="/app/invitations">Review them</a>
          </p>
        )}
      </div>

      <div className="card-section">
        <h2>Not built yet</h2>
        <p>
          Campaigns, contacts, call history, billing and wallet are not available. This dashboard
          deliberately shows nothing for them rather than placeholder figures. The permissions that
          will govern them already exist in the registry.
        </p>
      </div>
    </>
  );
}
