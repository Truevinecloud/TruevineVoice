import { selectMembership } from '../../../lib/organization-context';
import { redirect } from 'next/navigation';
import { currentSession, hasPermission } from '../../../lib/session';
import { GroupsView } from './GroupsView';
import { PageHeader } from '../AppUI';

export default async function ContactGroupsPage({
  searchParams,
}: {
  readonly searchParams: Promise<{ readonly organization?: string | string[] }>;
}): Promise<React.JSX.Element> {
  const session = await currentSession();
  if (!session.ok) redirect('/sign-in');
  if (!session.me.termsAccepted) redirect('/accept-terms');
  const params = await searchParams;
  const membership = selectMembership(session.me.memberships, params.organization);
  if (!membership || !hasPermission(membership, 'contact:read'))
    return (
      <>
        <PageHeader title="Contact groups" />
        <p role="alert">You do not have access to contact groups in the selected organization.</p>
      </>
    );
  return (
    <GroupsView
      key={membership.organizationId}
      organizationId={membership.organizationId}
      organizationName={membership.organizationName}
      canCreate={hasPermission(membership, 'contact:create')}
      canUpdate={hasPermission(membership, 'contact:update')}
    />
  );
}
