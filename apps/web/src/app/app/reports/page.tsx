import { redirect } from 'next/navigation';

import { fetchCampaignStatusReport } from '../../../lib/org-api';
import { currentSession, hasPermission } from '../../../lib/session';
import { EmptyState, PageHeader, SectionCard } from '../AppUI';

/**
 * A read-only status report built from campaign records.
 *
 * It counts records, not executions. A draft is a prepared record: it is not a
 * queued call, a placed call, or a delivery. Saying so on the page is part of the
 * report being honest, not a disclaimer bolted on.
 */
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
  const other = report === null ? 0 : report.total - report.draft - report.active - report.completed;

  return (
    <>
      <PageHeader
        title="Reports"
        eyebrow={membership.organizationName}
        description="Campaign inventory summary. This report counts campaign records only; it does not measure calls or delivery."
      />
      {report === null ? (
        <p className="notice notice-error" role="alert">
          The report could not be loaded. Try again, or sign in again if your session ended.
        </p>
      ) : report.total === 0 ? (
        <SectionCard title="Campaigns by status">
          <EmptyState title="No campaign records to report">
            A Campaign Manager can prepare a draft. Drafts appear here as records, and preparing one
            never places a call.
          </EmptyState>
        </SectionCard>
      ) : (
        <SectionCard
          title="Campaigns by status"
          description="Every figure is the count of records the API returned for this organization."
        >
          <dl className="report-metrics">
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
            {other > 0 && (
              <div>
                <dt>Other statuses</dt>
                <dd>{other}</dd>
              </div>
            )}
          </dl>
          <p className="notice notice-info">
            Drafts are prepared records. Their count does not mean calls are scheduled, running or
            complete, and it does not include call attempts or delivery outcomes.
          </p>
        </SectionCard>
      )}
      <p className="field-hint">
        Call attempts, delivery outcomes, and performance metrics are not available yet. No figures
        on this page are estimated.
      </p>
    </>
  );
}
