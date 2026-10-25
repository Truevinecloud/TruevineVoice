import { redirect } from 'next/navigation';

import { fetchCampaignStatusReport } from '../../../lib/org-api';
import { currentSession, hasPermission } from '../../../lib/session';
import { PageHeader, SectionCard } from '../AppUI';

/** A read-only status report built from the campaign records currently available. */
export default async function ReportsPage({
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

  if (!membership || !hasPermission(membership, 'reporting:read')) {
    return (
      <>
        <PageHeader title="Reports" />
        <p className="notice notice-error" role="alert">
          You do not have reporting access in this organization.
        </p>
      </>
    );
  }

  const report = await fetchCampaignStatusReport(membership.organizationId);

  return (
    <>
      <PageHeader
        title="Reports"
        eyebrow={membership.organizationName}
        description="Campaign inventory summary. This report includes campaign record status only."
      />
      {report === null ? (
        <p role="alert">The report could not be loaded.</p>
      ) : (
        <SectionCard
          title="Campaigns by status"
          description="This report includes campaign record status only."
        >
          <dl>
            <div>
              <dt>Total campaigns</dt>
              <dd>{report.total}</dd>
            </div>
            <div>
              <dt>Draft</dt>
              <dd>{report.draft}</dd>
            </div>
            <div>
              <dt>Active</dt>
              <dd>{report.active}</dd>
            </div>
            <div>
              <dt>Completed</dt>
              <dd>{report.completed}</dd>
            </div>
          </dl>
        </SectionCard>
      )}
      <p className="field-hint">
        Call attempts, delivery outcomes, and performance metrics are not available yet.
      </p>
    </>
  );
}
