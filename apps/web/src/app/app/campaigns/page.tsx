import { redirect } from 'next/navigation';

import { fetchCampaigns } from '../../../lib/org-api';
import { CampaignAudio } from './campaign-audio';
import { CampaignBuilder } from './campaign-builder';
import { currentSession, hasPermission } from '../../../lib/session';
import { EmptyState, PageHeader, SectionCard } from '../AppUI';

/** Read-only campaign inventory for organization members with campaign:read. */
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
  const canUpdate = hasPermission(membership, 'campaign:update');

  const campaigns = await fetchCampaigns(membership.organizationId);

  return (
    <>
      <PageHeader
        title="Campaigns"
        eyebrow={membership.organizationName}
        description="Prepare campaign drafts and review their readiness. Outbound calling is not started from this workspace."
      />
      {campaigns !== null && (
        <CampaignBuilder
          organizationId={membership.organizationId}
          initialCampaigns={campaigns}
          canUpdate={canUpdate}
        />
      )}
      {campaigns === null ? (
        <p role="alert">Campaigns could not be loaded.</p>
      ) : campaigns.length === 0 ? (
        <SectionCard>
          <EmptyState title="No campaigns yet">
            Create a draft to select audio, choose an audience, and review preflight readiness.
          </EmptyState>
        </SectionCard>
      ) : (
        <SectionCard
          title="Campaign drafts"
          description="Current campaign records for this organization."
        >
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Campaign</th>
                <th scope="col">Status</th>
                <th scope="col">Created</th>
                <th scope="col">Updated</th>
                <th scope="col">Audio</th>
              </tr>
            </thead>
            <tbody>
              {campaigns.map((campaign) => (
                <tr key={campaign.id}>
                  <th scope="row">{campaign.name}</th>
                  <td>{campaign.status}</td>
                  <td>{new Date(campaign.createdAt).toISOString().slice(0, 10)}</td>
                  <td>{new Date(campaign.updatedAt).toISOString().slice(0, 10)}</td>
                  <td>
                    <CampaignAudio
                      organizationId={membership.organizationId}
                      campaign={campaign}
                      canUpdate={canUpdate}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </SectionCard>
      )}
      <p className="notice notice-info">
        Campaign execution and call outcome data are not available yet. Saving a draft or running
        preflight does not place calls.
      </p>
    </>
  );
}
