'use client';

import { useEffect, useState } from 'react';

import { ApiError, request } from '../../../lib/api';
import {
  ANALYTICS_PAGE_SIZE,
  analyticsPath,
  analyticsPageQueryString,
  analyticsFilterError,
  analyticsQueryFromLocal,
  analyticsQueryString,
  downloadAnalyticsCsv,
  formatAnalyticsMoney,
  type AnalyticsCallLogsResponse,
  type AnalyticsCampaignsResponse,
  type AnalyticsQuery,
  type AnalyticsSummaryResponse,
} from '../../../lib/analytics';
import { formatDateTime } from '../../../lib/datetime';
import { EmptyState, SectionCard, StatusBadge } from '../AppUI';
import {
  AnalyticsMetrics,
  AnalyticsNotice,
  AnalyticsPager,
  AnalyticsStatusBreakdown,
} from './analytics-parts';
import { CallLogsTable } from './call-logs';

function campaignTone(status: string): 'neutral' | 'success' | 'warning' | 'info' {
  switch (status) {
    case 'ACTIVE':
      return 'success';
    case 'PAUSED':
      return 'warning';
    case 'DRAFT':
      return 'info';
    default:
      return 'neutral';
  }
}

/** Full customer analytics workspace over the six read-only API routes. */
export function AnalyticsDashboard({
  organizationId,
}: {
  readonly organizationId: string;
}): React.JSX.Element {
  const [fromLocal, setFromLocal] = useState('');
  const [toLocal, setToLocal] = useState('');
  const [selectedCampaignIds, setSelectedCampaignIds] = useState<readonly string[]>([]);
  const [applied, setApplied] = useState<AnalyticsQuery>({});
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [requestKey, setRequestKey] = useState(0);
  const [loadedOrganizationId, setLoadedOrganizationId] = useState('');
  const [errorState, setErrorState] = useState<{
    readonly organizationId: string;
    readonly cause: unknown;
  } | null>(null);
  const [summary, setSummary] = useState<AnalyticsSummaryResponse | null>(null);
  const [campaigns, setCampaigns] = useState<AnalyticsCampaignsResponse | null>(null);
  const [calls, setCalls] = useState<AnalyticsCallLogsResponse | null>(null);

  const appliedFrom = applied.from ?? '';
  const appliedTo = applied.to ?? '';
  const appliedCampaignKey = (applied.campaignIds ?? []).join('|');
  const error = errorState?.organizationId === organizationId ? errorState.cause : null;
  const current = loadedOrganizationId === organizationId;
  const showingLoading = loading || (!current && error === null);

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    const query: AnalyticsQuery = {
      campaignIds: appliedCampaignKey.length === 0 ? [] : appliedCampaignKey.split('|'),
      ...(appliedFrom ? { from: appliedFrom } : {}),
      ...(appliedTo ? { to: appliedTo } : {}),
    };

    void Promise.all([
      request<AnalyticsSummaryResponse>(
        analyticsPath(organizationId, 'summary', analyticsQueryString(query)),
        { signal: controller.signal },
      ),
      request<AnalyticsCampaignsResponse>(
        analyticsPath(organizationId, 'campaigns', analyticsQueryString(query)),
        { signal: controller.signal },
      ),
      request<AnalyticsCallLogsResponse>(
        analyticsPath(
          organizationId,
          'calls',
          analyticsPageQueryString({ ...query, page, pageSize: ANALYTICS_PAGE_SIZE }),
        ),
        { signal: controller.signal },
      ),
    ])
      .then(([summaryResult, campaignResult, callResult]) => {
        if (!active) return;
        setSummary(summaryResult);
        setCampaigns(campaignResult);
        setCalls(callResult);
        setLoadedOrganizationId(organizationId);
        setErrorState(null);
      })
      .catch((cause: unknown) => {
        if (!active || controller.signal.aborted) return;
        // A failed report must never leave an earlier organization's numbers on
        // screen or substitute zeroes for unreconciled evidence.
        setSummary(null);
        setCampaigns(null);
        setCalls(null);
        setLoadedOrganizationId('');
        setErrorState({ organizationId, cause });
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
      controller.abort();
    };
  }, [organizationId, appliedFrom, appliedTo, appliedCampaignKey, page, requestKey]);

  function startRequest(): void {
    setLoading(true);
    setRequestKey((key) => key + 1);
    setLoadedOrganizationId('');
    setErrorState(null);
    setSummary(null);
    setCampaigns(null);
    setCalls(null);
  }

  function showValidationError(message: string): void {
    setLoading(false);
    setLoadedOrganizationId('');
    setErrorState({
      organizationId,
      cause: new ApiError(400, 'invalid_request', message),
    });
    setSummary(null);
    setCampaigns(null);
    setCalls(null);
  }

  function applyFilters(event: React.FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const invalid = analyticsFilterError(fromLocal, toLocal);
    if (invalid !== null) {
      showValidationError(invalid);
      return;
    }
    if (selectedCampaignIds.length > 100) {
      showValidationError('Select no more than 100 campaigns.');
      return;
    }

    startRequest();
    setApplied(analyticsQueryFromLocal(fromLocal, toLocal, selectedCampaignIds));
    setPage(1);
  }

  function clearFilters(): void {
    startRequest();
    setFromLocal('');
    setToLocal('');
    setSelectedCampaignIds([]);
    setApplied({});
    setPage(1);
  }

  function changePage(nextPage: number): void {
    startRequest();
    setPage(nextPage);
  }

  async function exportCsv(): Promise<void> {
    setExporting(true);
    setErrorState(null);
    try {
      await downloadAnalyticsCsv(organizationId, applied);
    } catch (cause) {
      setSummary(null);
      setCampaigns(null);
      setCalls(null);
      setLoadedOrganizationId('');
      setErrorState({ organizationId, cause });
    } finally {
      setExporting(false);
    }
  }

  const campaignNames: Readonly<Record<string, string>> = Object.fromEntries(
    (campaigns?.campaigns ?? []).map((campaign) => [campaign.campaignId, campaign.name]),
  );

  return (
    <>
      <SectionCard
        title="Call analytics"
        description="Live totals from the authenticated analytics API for this organization. No figures are estimated."
      >
        <form className="analytics-filters" onSubmit={applyFilters}>
          <label className="field">
            <span>From</span>
            <input
              className="input"
              type="datetime-local"
              value={fromLocal}
              onChange={(event) => setFromLocal(event.target.value)}
            />
          </label>
          <label className="field">
            <span>To (exclusive)</span>
            <input
              className="input"
              type="datetime-local"
              value={toLocal}
              onChange={(event) => setToLocal(event.target.value)}
            />
          </label>
          <label className="field analytics-filters__campaigns">
            <span>Campaigns</span>
            <select
              className="select"
              multiple
              size={4}
              value={[...selectedCampaignIds]}
              onChange={(event) =>
                setSelectedCampaignIds(
                  Array.from(event.target.selectedOptions, (option) => option.value),
                )
              }
            >
              {(campaigns?.campaigns ?? []).map((campaign) => (
                <option key={campaign.campaignId} value={campaign.campaignId}>
                  {campaign.name}
                </option>
              ))}
              {(campaigns?.campaigns ?? []).length === 0 && (
                <option value="" disabled>
                  No campaigns available
                </option>
              )}
            </select>
          </label>
          <div className="analytics-filters__actions">
            <button className="button-primary" type="submit" disabled={loading}>
              Apply filters
            </button>
            <button className="button-secondary" type="button" onClick={clearFilters}>
              Clear
            </button>
            <button
              className="button-secondary"
              type="button"
              onClick={() => void exportCsv()}
              disabled={loading || exporting}
            >
              {exporting ? 'Preparing CSV…' : 'Download CSV'}
            </button>
          </div>
        </form>
        <p className="field-hint">
          Leave dates blank for all available history. Exports contain up to 10,000 rows; narrow the
          filters if the API reports an oversized export.
        </p>
      </SectionCard>

      {error !== null && <AnalyticsNotice error={error} />}

      {showingLoading ? (
        <p className="notice notice-info" role="status" aria-busy="true">
          Loading analytics…
        </p>
      ) : current && summary !== null && campaigns !== null && calls !== null ? (
        <>
          <SectionCard
            title="Organization totals"
            description="Every value below is returned by the analytics API for the applied filters."
          >
            {summary.totals.attempts === 0 ? (
              <EmptyState title="No call attempts yet">
                No attempts match the current filters. These zeros are the actual empty result
                returned by the API, not a replacement for a failed reconciliation.
              </EmptyState>
            ) : (
              <AnalyticsMetrics totals={summary.totals} />
            )}
          </SectionCard>

          <SectionCard
            title="Campaign performance"
            description="Per-campaign attempts, answered/completed counts and exact customer spend."
          >
            {campaigns.campaigns.length === 0 ? (
              <EmptyState title="No campaigns to report">No campaign records were returned.</EmptyState>
            ) : (
              <div className="table-scroll">
                <table className="table">
                  <caption className="visually-hidden">Campaign analytics for the organization</caption>
                  <thead>
                    <tr>
                      <th scope="col">Campaign</th>
                      <th scope="col">Status</th>
                      <th scope="col">Attempts</th>
                      <th scope="col">Answered</th>
                      <th scope="col">Completed</th>
                      <th scope="col">Failed</th>
                      <th scope="col">Spend</th>
                    </tr>
                  </thead>
                  <tbody>
                    {campaigns.campaigns.map((campaign) => (
                      <tr key={campaign.campaignId}>
                        <td>
                          <strong>{campaign.name}</strong>
                          <br />
                          <small>{formatDateTime(campaign.createdAt)}</small>
                        </td>
                        <td>
                          <StatusBadge tone={campaignTone(campaign.status)}>{campaign.status}</StatusBadge>
                        </td>
                        <td>{campaign.attempts}</td>
                        <td>{campaign.answered}</td>
                        <td>{campaign.statusCounts.COMPLETED ?? 0}</td>
                        <td>{campaign.statusCounts.FAILED ?? 0}</td>
                        <td className="analytics-money">{formatAnalyticsMoney(campaign.spend)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </SectionCard>

          <SectionCard
            title="Status breakdown"
            description="Current attempt states from the immutable call-attempt records."
          >
            <AnalyticsStatusBreakdown counts={summary.totals.statusCounts} />
          </SectionCard>

          <SectionCard
            title="Call logs"
            description="Paginated call attempts for the applied filters."
          >
            <CallLogsTable items={calls.items} campaignNames={campaignNames} />
            <AnalyticsPager
              page={calls.page}
              pageSize={calls.pageSize}
              total={calls.total}
              totalPages={calls.totalPages}
              onPage={changePage}
            />
          </SectionCard>
        </>
      ) : null}
    </>
  );
}
