import { currentSession, hasPermission } from '../../../../lib/session';
import { selectMembership } from '../../../../lib/organization-context';
import { redirect } from 'next/navigation';
import { ORGANIZATION_ROLE_PERMISSIONS, type OrganizationRole } from '@truevine/auth';
import { PageHeader } from '../../AppUI';
import { CreateRoleForm } from './CreateRoleForm';

export default async function CreateRolePage({
  searchParams,
}: {
  readonly searchParams: Promise<{ readonly organization?: string | string[] }>;
}): Promise<React.JSX.Element> {
  const session = await currentSession();
  if (!session.ok) redirect('/sign-in');

  const params = await searchParams;
  const membership = selectMembership(session.me.memberships, params.organization);
  if (!membership) redirect('/app');

  if (!hasPermission(membership, 'organization:update')) {
    return (
      <>
        <PageHeader title="Create Custom Role" />
        <p className="notice notice-error">You do not have permission to create roles in this organization.</p>
      </>
    );
  }

  const actorPermissions = ORGANIZATION_ROLE_PERMISSIONS[membership.role as OrganizationRole] ?? [];
  const allActorPermissions = [...new Set([...actorPermissions, ...(membership.permissions ?? [])])];

  return (
    <CreateRoleForm
      organizationId={membership.organizationId}
      organizationName={membership.organizationName}
      delegablePermissions={allActorPermissions}
    />
  );
}
