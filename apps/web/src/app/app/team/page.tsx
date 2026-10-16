import { redirect } from 'next/navigation';

import { fetchMembers } from '../../../lib/org-api';
import { currentSession, hasPermission } from '../../../lib/session';

import { RemoveMemberButton, TransferOwnershipButton } from './actions';

/** `/app/team` - organization members. */
export default async function TeamPage({
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

  if (!hasPermission(membership, 'member:read')) {
    return (
      <>
        <h1 className="page-title">Team</h1>
        <p className="notice notice-error">
          You do not have permission to view members of this organization.
        </p>
      </>
    );
  }

  const members = await fetchMembers(membership.organizationId);

  if (members === null) {
    return (
      <>
        <h1 className="page-title">Team</h1>
        <p className="notice notice-error">Members could not be loaded.</p>
      </>
    );
  }

  const canInvite = hasPermission(membership, 'member:invite');
  const canUpdate = hasPermission(membership, 'member:update');
  const canRemove = hasPermission(membership, 'member:remove');
  const canTransfer = hasPermission(membership, 'ownership:transfer');

  return (
    <>
      <h1 className="page-title">Team</h1>
      <p style={{ color: '#5b6472', marginTop: '-0.5rem' }}>
        Everyone with access to {membership.organizationName}.
      </p>

      {canInvite && (
        <p>
          <a
            className="button-secondary"
            href="/app/team/invite"
            style={{ display: 'inline-block' }}
          >
            Invite someone
          </a>
        </p>
      )}

      <table className="table">
        <thead>
          <tr>
            <th scope="col">Email</th>
            <th scope="col">Role</th>
            <th scope="col">Joined</th>
            <th scope="col">
              <span className="visually-hidden">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {members.map((member) => {
            const isSelf = member.userId === session.me.userId;

            return (
              <tr key={member.userId}>
                <td>
                  {member.email}
                  {isSelf && <span className="field-hint"> (you)</span>}
                </td>
                <td>
                  <span className={`tag ${member.role === 'OWNER' ? 'tag-owner' : ''}`}>
                    {member.role.replace(/_/g, ' ')}
                  </span>
                </td>
                <td>{new Date(member.joinedAt).toISOString().slice(0, 10)}</td>
                <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                  {canTransfer && !isSelf && member.role !== 'OWNER' && (
                    <TransferOwnershipButton
                      organizationId={membership.organizationId}
                      userId={member.userId}
                      email={member.email}
                    />
                  )}
                  {canRemove && !isSelf && (
                    <RemoveMemberButton
                      organizationId={membership.organizationId}
                      userId={member.userId}
                      email={member.email}
                    />
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {canUpdate && (
        <p className="field-hint">
          Changing somebody&apos;s role is done from the invite and role controls. You can only
          grant roles that hold no more authority than your own.
        </p>
      )}
    </>
  );
}
