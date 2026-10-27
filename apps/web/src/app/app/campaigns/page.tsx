import { redirect } from 'next/navigation';

import { fetchCampaigns } from '../../../lib/org-api';
import { currentSession, hasPermission } from '../../../lib/session';
import { PageHeader } from '../AppUI';
import { CampaignsWorkspace } from './campaigns-workspace';

/**
 * Campaign workspace for organization members with campaign:read.
 *
 * The server resolves the organization from the caller's own memberships and
 * loads the initial inventory. Everything a Campaign Manager can change stays in
 * the client workspace, which can refresh the list after a save without a full
 * page navigation.
 */
export default async function CampaignsPage({
  searchParams,
}: {
  readonly searchParams: Promise<{ readonly organization?: string | string[] }>;
}): Promise<React.JSX.Element> {
  const session = await currentSession();
  if (!session.ok) redirect('/sign-in');
  if (!session.me.termsAccepted) redirect('/accept-terms');

  const params = await searchParams;
  const requested = Array.isArray(params.organization)
    ? params.organization[0]
    : params.organization;
  const membership =
    requested === undefined
      ? session.me.memberships[0]
      : session.me.memberships.find((entry) => entry.organizationId === requested);

  if (!membership || !hasPermission(membership, 'campaign:read')) {
    return (
      <>
        <PageHeader title="Campaigns" />
        <p className="notice notice-error" role="alert">
          You do not have campaign access in this organization.
        </p>
      </>
    );
  }

  const campaigns = await fetchCampaigns(membership.organizationId);

  return (
    <>
      <PageHeader
        title="Campaigns"
        eyebrow={membership.organizationName}
        description="Prepare campaign drafts and review their readiness. Outbound calling is not started from this workspace."
      />
      {campaigns === null ? (
        <p className="notice notice-error" role="alert">
          Campaigns could not be loaded. Refresh the page or sign in again if your session ended.
        </p>
      ) : (
        <CampaignsWorkspace
          organizationId={membership.organizationId}
          initialCampaigns={campaigns}
          canUpdate={hasPermission(membership, 'campaign:update')}
          canDelete={hasPermission(membership, 'campaign:delete')}
        />
      )}
    </>
  );
}
