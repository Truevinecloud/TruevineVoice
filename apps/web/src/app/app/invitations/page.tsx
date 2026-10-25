import { redirect } from 'next/navigation';

import { fetchInvitations } from '../../../lib/org-api';
import { currentSession, hasPermission } from '../../../lib/session';

import { RevokeInvitationButton } from './RevokeInvitationButton';
import { EmptyState, PageHeader, SectionCard } from '../AppUI';

/** `/app/invitations` - pending and past invitations. */
export default async function InvitationsPage({
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

  const membership =
    session.me.memberships.find((entry) => entry.organizationId === requested) ??
    session.me.memberships[0];

  if (!membership) redirect('/app');

  if (!hasPermission(membership, 'invitation:read')) {
    return (
      <>
        <PageHeader title="Invitations" />
        <p className="notice notice-error">
          Your role cannot view invitations for this organization.
        </p>
      </>
    );
  }

  const invitations = await fetchInvitations(membership.organizationId);

  if (invitations === null) {
    return (
      <>
        <PageHeader title="Invitations" eyebrow={membership.organizationName} />
        <p className="notice notice-error">Invitations could not be loaded.</p>
      </>
    );
  }

  const outstanding = invitations.filter((invitation) => invitation.outstanding);
  const settled = invitations.filter((invitation) => !invitation.outstanding);
  const canRevoke = hasPermission(membership, 'invitation:revoke');

  return (
    <>
      <PageHeader
        title="Invitations"
        eyebrow={membership.organizationName}
        description="Track access invitations for your organization."
      />

      <SectionCard
        title="Waiting for a response"
        description="Invitations that have not yet been accepted or revoked."
      >
        {outstanding.length === 0 ? (
          <EmptyState title="No outstanding invitations">
            New invitations will appear here until they are accepted or expire.
          </EmptyState>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Email</th>
                <th scope="col">Role</th>
                <th scope="col">Expires</th>
                <th scope="col">
                  <span className="visually-hidden">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {outstanding.map((invitation) => (
                <tr key={invitation.id}>
                  <td>{invitation.email}</td>
                  <td>
                    <span className="tag">{invitation.role.replace(/_/g, ' ')}</span>
                  </td>
                  <td>{new Date(invitation.expiresAt).toISOString().slice(0, 10)}</td>
                  <td style={{ textAlign: 'right' }}>
                    {canRevoke && (
                      <RevokeInvitationButton
                        organizationId={membership.organizationId}
                        invitationId={invitation.id}
                        email={invitation.email}
                      />
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </SectionCard>

      <SectionCard title="Accepted or revoked" description="Previously completed invitations.">
        {settled.length === 0 ? (
          <EmptyState title="No invitation history">
            Completed invitations will appear here.
          </EmptyState>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Email</th>
                <th scope="col">Role</th>
                <th scope="col">Outcome</th>
              </tr>
            </thead>
            <tbody>
              {settled.map((invitation) => (
                <tr key={invitation.id}>
                  <td>{invitation.email}</td>
                  <td>{invitation.role.replace(/_/g, ' ')}</td>
                  <td>{invitation.acceptedAt !== null ? 'Accepted' : 'Revoked or expired'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </SectionCard>
    </>
  );
}
