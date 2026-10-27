import { redirect } from 'next/navigation';

import { fetchCampaigns, fetchInvitations, fetchMembers, fetchOrganization } from '../../lib/org-api';
import { summarizeCampaigns } from '../../lib/campaigns';
import { currentSession, hasPermission } from '../../lib/session';
import { EmptyState, PageHeader, SectionCard } from './AppUI';

/**
 * Organization dashboard.
 *
 * It shows only surfaces the caller's role can actually open, and derives every
 * number from records the API returned. A role without member, invitation or
 * billing permissions is not told about those areas at all: an empty card that
 * says "no permission" still reads as a feature the organization has.
 */
export default async function DashboardPage({
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

  const memberships = session.me.memberships;

  // Only ever fall back to a membership the caller actually holds. Reading an
  // organization id from the URL without checking it is the cross-tenant bug
  // this whole task exists to prevent.
  const membership =
    requested === undefined
      ? memberships[0]
      : memberships.find((entry) => entry.organizationId === requested);

  if (requested !== undefined && !membership) {
    return (
      <>
        <PageHeader title="Dashboard" description="Your organization workspace." />
        <p className="notice notice-error" role="alert">
          You do not have access to the selected organization.
        </p>
      </>
    );
  }

  if (!membership) {
    return (
      <>
        <PageHeader title="Welcome" description="Your Truevine Voice account is ready." />
        <SectionCard>
          <EmptyState title="No organization yet">
            Accept an invitation, or ask an organization owner to invite you.
          </EmptyState>
        </SectionCard>
      </>
    );
  }

  const organizationId = membership.organizationId;
  const canReadMembers = hasPermission(membership, 'member:read');
  const canReadInvitations = hasPermission(membership, 'invitation:read');
  const canReadCampaigns = hasPermission(membership, 'campaign:read');
  const canReadContacts = hasPermission(membership, 'contact:read');
  const canReadReports = hasPermission(membership, 'reporting:read');
  const canReadAudio = hasPermission(membership, 'audio:read');
  const canReadBilling = hasPermission(membership, 'billing:read');

  const [organization, members, invitations, campaigns] = await Promise.all([
    fetchOrganization(organizationId),
    canReadMembers ? fetchMembers(organizationId) : Promise.resolve(null),
    canReadInvitations ? fetchInvitations(organizationId) : Promise.resolve(null),
    canReadCampaigns ? fetchCampaigns(organizationId) : Promise.resolve(null),
  ]);

  const outstanding = invitations?.filter((invitation) => invitation.outstanding) ?? null;
  const loadedCampaigns = campaigns ?? null;
  const campaignSummary =
    loadedCampaigns === null ? null : summarizeCampaigns(loadedCampaigns);
  const organizationParam = `organization=${encodeURIComponent(organizationId)}`;

  return (
    <>
      <PageHeader
        eyebrow="Organization workspace"
        title={organization?.name ?? membership.organizationName}
        description={`Signed in as ${membership.role.replace(/_/g, ' ').toLowerCase()} in this organization.`}
      />

      {(canReadContacts || canReadCampaigns || canReadReports || canReadAudio) && (
        <SectionCard title="Your workspace" description="Areas this role can open.">
          <nav className="dashboard-shortcuts" aria-label="Authorized workspace areas">
            {canReadContacts && (
              <a className="dashboard-shortcut" href={`/app/contacts?${organizationParam}`}>
                <strong>Contacts</strong>
                <span>Manage people, consent and suppression.</span>
              </a>
            )}
            {canReadCampaigns && (
              <a className="dashboard-shortcut" href={`/app/campaigns?${organizationParam}`}>
                <strong>Campaigns</strong>
                <span>Prepare drafts and review readiness.</span>
              </a>
            )}
            {canReadReports && (
              <a className="dashboard-shortcut" href={`/app/reports?${organizationParam}`}>
                <strong>Reports</strong>
                <span>Campaign record status.</span>
              </a>
            )}
            {canReadAudio && (
              <a className="dashboard-shortcut" href={`/app/audio?${organizationParam}`}>
                <strong>Audio Library</strong>
                <span>Record, upload or generate message audio when configured.</span>
              </a>
            )}
          </nav>
        </SectionCard>
      )}

      {canReadCampaigns && (
        <SectionCard
          title="Campaigns"
          description="Counts derived from this organization’s campaign records."
        >
          {loadedCampaigns === null || campaignSummary === null ? (
            <p className="notice notice-error" role="alert">
              Campaign records could not be loaded.
            </p>
          ) : loadedCampaigns.length === 0 ? (
            <EmptyState
              title="No campaign records yet"
              action={
                <a className="button-primary" href={`/app/campaigns?${organizationParam}`}>
                  Open campaigns
                </a>
              }
            >
              A Campaign Manager can prepare a draft. Preparing a draft does not place any calls.
            </EmptyState>
          ) : (
            <>
              <dl className="dashboard-metrics">
                <div>
                  <dt>Total records</dt>
                  <dd>{campaignSummary.total}</dd>
                </div>
                <div>
                  <dt>Drafts</dt>
                  <dd>{campaignSummary.drafts}</dd>
                </div>
                <div>
                  <dt>Drafts with a schedule</dt>
                  <dd>{campaignSummary.scheduledDrafts}</dd>
                </div>
                <div>
                  <dt>Other statuses</dt>
                  <dd>{campaignSummary.otherStatuses}</dd>
                </div>
              </dl>
              <p className="field-hint">
                Drafts and schedules are prepared records only. Execution and call outcomes are not
                available yet. <a href={`/app/campaigns?${organizationParam}`}>Open campaigns</a>
              </p>
            </>
          )}
        </SectionCard>
      )}

      {canReadMembers && (
        <SectionCard title="Team" description="People who have access to this organization.">
          {members === null ? (
            <p className="notice notice-error" role="alert">
              Team members could not be loaded.
            </p>
          ) : members.length === 0 ? (
            <p>No members are listed for this organization.</p>
          ) : (
            <p>
              {members.length} {members.length === 1 ? 'member' : 'members'}.{' '}
              <a href={`/app/team?${organizationParam}`}>View the team</a>
            </p>
          )}
        </SectionCard>
      )}

      {canReadInvitations && (
        <SectionCard
          title="Pending invitations"
          description="Outstanding invitations for this organization."
        >
          {outstanding === null ? (
            <p className="notice notice-error" role="alert">
              Invitations could not be loaded.
            </p>
          ) : outstanding.length === 0 ? (
            <p>No invitations are waiting for a response.</p>
          ) : (
            <p>
              {outstanding.length}{' '}
              {outstanding.length === 1 ? 'invitation is' : 'invitations are'} waiting for a
              response.{' '}
              <a href={`/app/invitations?${organizationParam}`}>Review them</a>
            </p>
          )}
        </SectionCard>
      )}

      {canReadBilling && (
        <SectionCard title="Billing" description="Wallet and plan details for this organization.">
          <p>
            <a href={`/app/billing?${organizationParam}`}>Open billing</a> to review the wallet and
            plan. No usage figures are estimated here.
          </p>
        </SectionCard>
      )}

      <SectionCard
        title="Product status"
        description="Availability based on the current implementation."
      >
        <p>
          Campaign execution, call history and campaign outcomes are not available yet. No activity
          metrics are fabricated. Areas without an entry in the navigation are not available to your
          role.
        </p>
      </SectionCard>
    </>
  );
}
