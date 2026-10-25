import { redirect } from 'next/navigation';

import { fetchOrganization } from '../../../lib/org-api';
import { currentSession, hasPermission } from '../../../lib/session';

import { OrganizationSettingsForm } from './OrganizationSettingsForm';
import { PageHeader, SectionCard } from '../AppUI';

/** `/app/settings` - organization profile. */
export default async function SettingsPage({
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

  const organization = await fetchOrganization(membership.organizationId);

  if (!organization) {
    return (
      <>
        <PageHeader title="Organization settings" />
        <p className="notice notice-error">
          You do not have permission to view this organization, or it no longer exists.
        </p>
      </>
    );
  }

  const canUpdate = hasPermission(membership, 'organization:update');

  return (
    <>
      <PageHeader
        title="Organization settings"
        eyebrow={membership.organizationName}
        description="Manage the profile for this organization."
      />

      <SectionCard
        title="Organization profile"
        description="The identifier is permanent and is shown for reference."
      >
        {canUpdate ? (
          <OrganizationSettingsForm
            organizationId={organization.id}
            slug={organization.slug}
            name={organization.name}
          />
        ) : (
          <>
            <p>
              <strong>{organization.name}</strong>
            </p>
            <p className="field-hint">
              Your role in this organization ({membership.role.replace(/_/g, ' ').toLowerCase()})
              does not include changing its settings.
            </p>
          </>
        )}
      </SectionCard>

      <SectionCard
        title="Operational settings"
        description="Features that are not yet configurable."
      >
        <p>
          Not available. There is nothing to configure yet: sending limits, caller identity and
          time-of-day rules all belong to modules that do not exist. The permissions that will
          govern them are already defined.
        </p>
      </SectionCard>
    </>
  );
}
