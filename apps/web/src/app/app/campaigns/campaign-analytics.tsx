'use client';

import { useEffect, useState } from 'react';

import { request } from '../../../lib/api';
import {
  ANALYTICS_PAGE_SIZE,
  analyticsPageQueryString,
  analyticsPath,
  type AnalyticsCampaignCallLogsResponse,
  type AnalyticsCampaignResponse,
} from '../../../lib/analytics';
import { formatDateTime } from '../../../lib/datetime';
import { StatusBadge } from '../AppUI';
import { AnalyticsMetrics, AnalyticsNotice, AnalyticsPager, AnalyticsStatusBreakdown } from '../reports/analytics-parts';
import { CallLogsTable } from '../reports/call-logs';

/**
 * Campaign-scoped analytics inside the existing campaign review panel.
 *
 * It calls only the two campaign analytics endpoints. With no filters applied
 * it is directly comparable to the organization report for the same campaign.
 */
export function CampaignAnalytics({
  organizationId,
  campaignId,
}: {
  readonly organizationId: string;
  readonly campaignId: string;
}): React.JSX.Element {
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [requestKey, setRequestKey] = useState(0);
  const [loadedScope, setLoadedScope] = useState('');
  const [errorState, setErrorState] = useState<{
    readonly scope: string;
    readonly cause: unknown;
  } | null>(null);
  const [detail, setDetail] = useState<AnalyticsCampaignResponse | null>(null);
  const [calls, setCalls] = useState<AnalyticsCampaignCallLogsResponse | null>(null);
  const encodedCampaign = encodeURIComponent(campaignId);
  const campaignPath = `campaigns/${encodedCampaign}`;
  const scope = `${organizationId}|${campaignPath}`;
  const error = errorState?.scope === scope ? errorState.cause : null;
  const current = loadedScope === scope;
  const showingLoading = loading || (!current && error === null);

  useEffect(() => {
    let active = true;
    const controller = new AbortController();

    void Promise.all([
      request<AnalyticsCampaignResponse>(analyticsPath(organizationId, campaignPath), {
        signal: controller.signal,
      }),
      request<AnalyticsCampaignCallLogsResponse>(
        analyticsPath(
          organizationId,
          `${campaignPath}/calls`,
          analyticsPageQueryString({ page, pageSize: ANALYTICS_PAGE_SIZE }),
        ),
        { signal: controller.signal },
      ),
    ])
      .then(([detailResult, callResult]) => {
        if (!active) return;
        setDetail(detailResult);
        setCalls(callResult);
        setLoadedScope(scope);
        setErrorState(null);
      })
      .catch((cause: unknown) => {
        if (!active || controller.signal.aborted) return;
        setDetail(null);
        setCalls(null);
        setLoadedScope('');
        setErrorState({ scope, cause });
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
      controller.abort();
    };
  }, [organizationId, campaignPath, page, requestKey, scope]);

  function changePage(nextPage: number): void {
    setLoading(true);
    setRequestKey((key) => key + 1);
    setLoadedScope('');
    setErrorState(null);
    setDetail(null);
    setCalls(null);
    setPage(nextPage);
  }

  return (
    <section className="campaign-analytics" aria-labelledby="campaign-analytics-heading">
      <header className="campaign-analytics__header">
        <div>
          <p className="campaign-detail__eyebrow">Campaign analytics</p>
          <h3 id="campaign-analytics-heading">Call outcomes and spend</h3>
        </div>
        {detail !== null && (
          <StatusBadge tone="info">Reconciled with ledger</StatusBadge>
        )}
      </header>

      {error !== null && <AnalyticsNotice error={error} />}

      {showingLoading ? (
        <p className="notice notice-info" role="status" aria-busy="true">
          Loading campaign analytics…
        </p>
      ) : current && detail !== null && calls !== null ? (
        <>
          <AnalyticsMetrics totals={detail.campaign} />
          <div className="campaign-analytics__meta">
            <span>
              Campaign created {formatDateTime(detail.campaign.createdAt)}
            </span>
            <span>Campaign ID {detail.campaign.campaignId}</span>
          </div>
          <h4>Status breakdown</h4>
          <AnalyticsStatusBreakdown counts={detail.campaign.statusCounts} />
          <h4>Campaign call logs</h4>
          <CallLogsTable
            items={calls.items}
            campaignNames={{ [detail.campaign.campaignId]: detail.campaign.name }}
            emptyTitle="No call attempts for this campaign"
          />
          <AnalyticsPager
            page={calls.page}
            pageSize={calls.pageSize}
            total={calls.total}
            totalPages={calls.totalPages}
            onPage={changePage}
          />
          <p className="field-hint">
            These unfiltered totals use the same campaign scope as the organization analytics
            campaign row. Answered is a current-state proxy, not an answer rate.
          </p>
        </>
      ) : null}
    </section>
  );
}
