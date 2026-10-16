import { redirect } from 'next/navigation';
import { delegableRoles } from '@truevine/auth';

import { currentSession, hasPermission } from '../../../../lib/session';

import { InviteForm } from './InviteForm';

/** `/app/team/invite` */
export default async function InvitePage({
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

  if (!hasPermission(membership, 'member:invite')) {
    return (
      <>
        <h1 className="page-title">Invite someone</h1>
        <p className="notice notice-error">
          Your role in this organization cannot invite new members.
        </p>
      </>
    );
  }

  return (
    <>
      <h1 className="page-title">Invite someone</h1>
      <p style={{ color: '#5b6472', marginTop: '-0.5rem' }}>
        They will receive a single-use link to join {membership.organizationName}.
      </p>

      <div className="card-section">
        <InviteForm
          organizationId={membership.organizationId}
          organizationName={membership.organizationName}
          roles={delegableRoles(membership.role)}
        />
      </div>
    </>
  );
}
