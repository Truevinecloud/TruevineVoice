import { OrganizationAccessDenied } from '../AppUI';
import { selectMembership } from '../../../lib/organization-context';
import { redirect } from 'next/navigation';
import { fetchRoles, fetchOrganizationMembers } from '../../../lib/org-api';
import { currentSession, hasPermission } from '../../../lib/session';
import { PageHeader, SectionCard, Tag } from '../AppUI';
import { RoleRow } from './RoleRow';

export default async function RolesPage({
  searchParams,
}: {
  readonly searchParams: Promise<{ readonly organization?: string | string[] }>;
}): Promise<React.JSX.Element> {
  const session = await currentSession();
  if (!session.ok) redirect('/sign-in');

  const params = await searchParams;
  const membership = selectMembership(session.me.memberships, params.organization);
  if (!membership) return <OrganizationAccessDenied />;

  if (!hasPermission(membership, 'organization:update')) {
    return (
      <>
        <PageHeader title="Roles & Permissions" />
        <p className="notice notice-error">You do not have permission to manage roles in this organization.</p>
      </>
    );
  }

  const roles = await fetchRoles(membership.organizationId);
  const members = await fetchOrganizationMembers(membership.organizationId);

  if (roles === null || members === null) {
    return (
      <>
        <PageHeader title="Roles & Permissions" eyebrow={membership.organizationName} />
        <p className="notice notice-error">Roles could not be loaded.</p>
      </>
    );
  }

  const canCreate = hasPermission(membership, 'organization:update');

  return (
    <>
      <PageHeader
        title="Roles & Permissions"
        eyebrow={membership.organizationName}
        description="Define custom roles and assign them to team members. System roles are defined by Truevine Voice and cannot be modified."
        actions={
          canCreate && (
            <a
              className="button-primary"
              href={`/app/roles/create?organization=${encodeURIComponent(membership.organizationId)}`}
            >
              Create custom role
            </a>
          )
        }
      />
      <SectionCard
        title="Custom Roles"
        description={`${roles.custom.length} custom role${roles.custom.length === 1 ? '' : 's'} defined in this organization.`}
      >
        {roles.custom.length === 0 ? (
          <div className="empty-state">
            <p>No custom roles yet.</p>
            {canCreate && (
              <a className="button-primary" href={`/app/roles/create?organization=${encodeURIComponent(membership.organizationId)}`}>
                Create your first role
              </a>
            )}
          </div>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Name</th>
                  <th scope="col">Type</th>
                  <th scope="col">Permissions</th>
                  <th scope="col">Assigned</th>
                  <th scope="col">
                    <span className="visually-hidden">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {roles.custom.map((role) => (
                  <RoleRow
                    key={role.id}
                    role={role}
                    organizationId={membership.organizationId}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>

      <SectionCard
        title="System Roles"
        description="Built-in roles provided by Truevine Voice. These cannot be modified or deleted."
      >
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Type</th>
                <th scope="col">Permissions</th>
                <th scope="col">Assigned</th>
              </tr>
            </thead>
            <tbody>
              {roles.system.map((role) => (
                <tr key={role.id}>
                  <td className="email-cell">
                    {role.name}
                    {role.description && <small>{role.description}</small>}
                  </td>
                  <td><Tag variant="system">System</Tag></td>
                  <td>
                    <div className="permission-tags">
                      {role.permissions.slice(0, 6).map((p) => (
                        <span key={p} className="permission-tag">{permissionLabel(p)}</span>
                      ))}
                      {role.permissions.length > 6 && (
                        <span className="permission-tag more">+{role.permissions.length - 6} more</span>
                      )}
                    </div>
                  </td>
                  <td>
                    {members.filter((m) => m.role === role.id).length}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </SectionCard>
    </>
  );
}

function permissionLabel(permission: string): string {
  return permission.replace(/_/g, ' ').replace(/:/g, ' — ');
}