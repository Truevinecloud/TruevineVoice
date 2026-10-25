import { redirect } from 'next/navigation';
import { delegableRoles } from '@truevine/auth';

import { currentSession, hasPermission } from '../../../../lib/session';

import { InviteForm } from './InviteForm';
import { PageHeader, SectionCard } from '../../AppUI';

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
        <PageHeader title="Invite a team member" eyebrow={membership.organizationName} />
        <p className="notice notice-error">
          Your role in this organization cannot invite new members.
        </p>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Invite a team member"
        eyebrow={membership.organizationName}
        description="They will receive a single-use invitation link to join this organization."
      />

      <SectionCard
        title="Invitation details"
        description="Assign a role no more powerful than the one you hold."
      >
        <InviteForm
          organizationId={membership.organizationId}
          organizationName={membership.organizationName}
          roles={delegableRoles(membership.role)}
        />
      </SectionCard>
    </>
  );
}
