'use client';

import { useEffect, useRef, useState } from 'react';

import { messageFor, request } from '../../../lib/api';
import {
  CAMPAIGN_STATUS_FILTERS,
  campaignStatusLabel,
  campaignStatusTone,
  filterCampaigns,
  paginate,
  summarizeCampaigns,
  type CampaignStatusFilter,
} from '../../../lib/campaigns';
import { formatDateTime } from '../../../lib/datetime';
import type { Campaign } from '../../../lib/org-api';
import { EmptyState, SectionCard, StatusBadge } from '../AppUI';
import { CampaignBuilder, type CampaignAudioAsset, type CampaignGroup } from './campaign-builder';
import { CampaignDetail } from './campaign-detail';

const PAGE_SIZE = 10;

/**
 * Campaign workspace.
 *
 * It owns the campaign collection, the group list and the audio list so a saved
 * draft refreshes in place and each row no longer fetches the audio library. The
 * read-only branch renders a static inventory: no form, no controls, and no
 * action words, because a role without campaign:update must not be offered a
 * button that the API will refuse.
 */
export function CampaignsWorkspace({
  organizationId,
  initialCampaigns,
  canUpdate,
  canDelete,
}: {
  readonly organizationId: string;
  readonly initialCampaigns: readonly Campaign[];
  readonly canUpdate: boolean;
  readonly canDelete: boolean;
}): React.JSX.Element {
  const [campaigns, setCampaigns] = useState<readonly Campaign[]>(initialCampaigns);
  const [groups, setGroups] = useState<readonly CampaignGroup[]>([]);
  const [assets, setAssets] = useState<readonly CampaignAudioAsset[]>([]);
  const [libraryLoading, setLibraryLoading] = useState(canUpdate);
  const [libraryError, setLibraryError] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<CampaignStatusFilter>('ALL');
  const [page, setPage] = useState(1);
  const [mode, setMode] = useState<'create' | 'edit' | 'detail' | null>(null);
  const [selectedId, setSelectedId] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const mounted = useRef(true);
  const base = `/organizations/${encodeURIComponent(organizationId)}`;

  useEffect(() => {
    mounted.current = true;
    if (!canUpdate) {
      // Nothing to load for a read-only role; `libraryLoading` already starts
      // false, so no state update belongs in this effect body.
      return () => {
        mounted.current = false;
      };
    }
    let active = true;
    void Promise.all([
      request<readonly CampaignGroup[]>(`${base}/contact-groups`),
      request<readonly CampaignAudioAsset[]>(`${base}/audio-assets`),
    ])
      .then(([groupRows, assetRows]) => {
        if (!active) return;
        setGroups(groupRows);
        setAssets(assetRows);
        setLibraryError('');
      })
      .catch((cause: unknown) => {
        if (active) setLibraryError(messageFor(cause));
      })
      .finally(() => {
        if (active) setLibraryLoading(false);
      });
    return () => {
      active = false;
      mounted.current = false;
    };
    // `base` is derived from organizationId, which is the only reason to refetch.
  }, [base, canUpdate]);

  const filtered = filterCampaigns(campaigns, { query, status });
  const view = paginate(filtered, page, PAGE_SIZE);
  const summary = summarizeCampaigns(campaigns);
  const selected = campaigns.find((campaign) => campaign.id === selectedId) ?? null;

  function choose(campaign: Campaign): void {
    setSelectedId(campaign.id);
    setMode('detail');
    setError('');
    setSuccess('');
  }

  function closePanel(): void {
    setMode(null);
    setSelectedId('');
    setError('');
  }

  async function refresh(): Promise<void> {
    setRefreshing(true);
    setError('');
    setSuccess('');
    try {
      const rows = await request<readonly Campaign[]>(`${base}/campaigns`);
      if (!mounted.current) return;
      setCampaigns(rows);
    } catch (cause) {
      if (mounted.current) setError(messageFor(cause));
    } finally {
      if (mounted.current) setRefreshing(false);
    }
  }

  function saved(campaign: Campaign): void {
    setCampaigns((items) => {
      const exists = items.some((item) => item.id === campaign.id);
      return exists
        ? items.map((item) => (item.id === campaign.id ? campaign : item))
        : [campaign, ...items];
    });
    setSelectedId(campaign.id);
    setMode('detail');
    setQuery('');
    setStatus('ALL');
    setError('');
    setSuccess('Draft saved. Review its readiness below; no call was placed.');
  }

  function deleted(campaignId: string): void {
    setCampaigns((items) => items.filter((item) => item.id !== campaignId));
    setSelectedId('');
    setMode(null);
    setError('');
    setSuccess('Draft deleted. No campaign history was changed.');
  }

  const executionNotice = (
    <p className="notice notice-info">
      Campaign execution and call outcome data are not available yet. Saving a draft or running
      preflight does not place calls and does not activate telephony, text to speech or a paid
      provider.
    </p>
  );

  const executivePanel = mode === 'create' || mode === 'edit' ? (
    <CampaignBuilder
      key={mode === 'edit' ? selectedId : 'new'}
      organizationId={organizationId}
      campaign={mode === 'edit' ? selected : null}
      groups={groups}
      assets={assets}
      onSaved={saved}
      onCancel={closePanel}
    />
  ) : mode === 'detail' && selected ? (
    <CampaignDetail
      organizationId={organizationId}
      campaign={selected}
      groups={groups}
      assets={assets}
      canUpdate={canUpdate}
      canDelete={canDelete}
      onEdit={() => {
        setMode('edit');
        setError('');
        setSuccess('');
      }}
      onDeleted={deleted}
      onClose={closePanel}
    />
  ) : null;

  if (!canUpdate && !canDelete) {
    return (
      <>
        <SectionCard
          title="Campaign inventory"
          description="Campaign records this role may read. No campaign controls are available to this role."
        >
          {campaigns.length === 0 ? (
            <EmptyState title="No campaign records yet">
              A Campaign Manager can prepare a draft, choose an audience and review readiness. This
              role can read records but cannot prepare or change them.
            </EmptyState>
          ) : (
            <table className="table">
              <caption className="visually-hidden">
                Campaign records for this organization, read-only
              </caption>
              <thead>
                <tr>
                  <th scope="col">Campaign</th>
                  <th scope="col">Status</th>
                  <th scope="col">Audience</th>
                  <th scope="col">Audio</th>
                  <th scope="col">Scheduled</th>
                  <th scope="col">Updated</th>
                </tr>
              </thead>
              <tbody>
                {campaigns.map((campaign) => (
                  <tr key={campaign.id}>
                    <th scope="row">{campaign.name}</th>
                    <td>
                      <StatusBadge tone={campaignStatusTone(campaign.status)}>
                        {campaignStatusLabel(campaign.status)}
                      </StatusBadge>
                    </td>
                    <td>{campaign.audienceGroupIds?.length ?? 0}</td>
                    <td>{campaign.audioAssetId ? 'Selected' : 'Not selected'}</td>
                    <td>{formatDateTime(campaign.scheduledAt)}</td>
                    <td>{formatDateTime(campaign.updatedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </SectionCard>
        {executionNotice}
      </>
    );
  }

  return (
    <>
      <div className="campaign-summary" aria-label="Campaign summary">
        <div>
          <span>Total records</span>
          <strong>{summary.total}</strong>
        </div>
        <div>
          <span>Drafts</span>
          <strong>{summary.drafts}</strong>
        </div>
        <div>
          <span>Drafts with a schedule</span>
          <strong>{summary.scheduledDrafts}</strong>
        </div>
        <div>
          <span>Other statuses</span>
          <strong>{summary.otherStatuses}</strong>
        </div>
      </div>

      {error && (
        <p className="notice notice-error" role="alert">
          {error}
        </p>
      )}
      {success && (
        <p className="notice notice-success" role="status">
          {success}
        </p>
      )}
      {libraryLoading && <p role="status">Loading audiences and audio…</p>}
      {libraryError && (
        <p className="notice notice-error" role="alert">
          Audiences and audio could not be loaded. {libraryError} Refresh to try again.
        </p>
      )}

      {executivePanel}

      {!mode && (
        <SectionCard
          title="Campaign drafts"
          description="Search and filter this organization’s campaign records. Only drafts can be edited, reviewed or deleted."
          actions={
            <div className="campaign-toolbar__actions">
              {canUpdate && (
                <button
                  className="button-primary"
                  type="button"
                  onClick={() => {
                    setMode('create');
                    setSuccess('');
                    setError('');
                  }}
                  disabled={refreshing}
                >
                  New campaign draft
                </button>
              )}
              <button
                className="button-secondary"
                type="button"
                onClick={() => void refresh()}
                disabled={refreshing}
              >
                {refreshing ? 'Refreshing…' : 'Refresh'}
              </button>
            </div>
          }
        >
          <div className="campaign-toolbar">
            <div className="field campaign-toolbar__search">
              <label htmlFor="campaign-search">Search campaigns</label>
              <input
                id="campaign-search"
                type="search"
                value={query}
                placeholder="Campaign name"
                onChange={(event) => {
                  setQuery(event.target.value);
                  setPage(1);
                }}
              />
            </div>
            <div className="field campaign-toolbar__status">
              <label htmlFor="campaign-status-filter">Status</label>
              <select
                id="campaign-status-filter"
                value={status}
                onChange={(event) => {
                  setStatus(event.target.value as CampaignStatusFilter);
                  setPage(1);
                }}
              >
                {CAMPAIGN_STATUS_FILTERS.map((value) => (
                  <option key={value} value={value}>
                    {value === 'ALL' ? 'All statuses' : campaignStatusLabel(value)}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {campaigns.length === 0 ? (
            <EmptyState title="No campaigns yet">
              Create a draft to select audio, choose an audience, and review preflight readiness.
            </EmptyState>
          ) : filtered.length === 0 ? (
            <EmptyState title="No campaigns match these filters">
              Try a different name or status. Clear the filters to see every campaign record.
            </EmptyState>
          ) : (
            <>
              <div className="table-scroll">
                <table className="table campaign-table">
                  <caption className="visually-hidden">
                    Campaign records, showing {view.from} to {view.to} of {view.total}
                  </caption>
                  <thead>
                    <tr>
                      <th scope="col">Campaign</th>
                      <th scope="col">Status</th>
                      <th scope="col">Audience</th>
                      <th scope="col">Audio</th>
                      <th scope="col">Scheduled</th>
                      <th scope="col">Updated</th>
                      <th scope="col">Review</th>
                    </tr>
                  </thead>
                  <tbody>
                    {view.items.map((campaign) => (
                      <tr key={campaign.id}>
                        <th scope="row">{campaign.name}</th>
                        <td>
                          <StatusBadge tone={campaignStatusTone(campaign.status)}>
                            {campaignStatusLabel(campaign.status)}
                          </StatusBadge>
                        </td>
                        <td>
                          {campaign.audienceGroupIds && campaign.audienceGroupIds.length > 0
                            ? `${campaign.audienceGroupIds.length} ${campaign.audienceGroupIds.length === 1 ? 'group' : 'groups'}`
                            : 'No groups'}
                        </td>
                        <td>
                          {assets.find((asset) => asset.id === campaign.audioAssetId)?.name ??
                            (campaign.audioAssetId ? 'Unavailable asset' : 'Not selected')}
                        </td>
                        <td>{formatDateTime(campaign.scheduledAt)}</td>
                        <td>{formatDateTime(campaign.updatedAt)}</td>
                        <td>
                          <button
                            className="button-secondary campaign-table__review"
                            type="button"
                            onClick={() => choose(campaign)}
                            aria-label={`Review campaign ${campaign.name}`}
                          >
                            Review
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="pagination" aria-label="Campaign pages">
                <span>
                  Showing {view.from}–{view.to} of {view.total}
                </span>
                <div className="pagination__controls">
                  <button
                    className="button-secondary"
                    type="button"
                    onClick={() => setPage((current) => Math.max(1, current - 1))}
                    disabled={view.page <= 1}
                  >
                    Previous
                  </button>
                  <span>
                    Page {view.page} of {view.pageCount}
                  </span>
                  <button
                    className="button-secondary"
                    type="button"
                    onClick={() => setPage((current) => Math.min(view.pageCount, current + 1))}
                    disabled={view.page >= view.pageCount}
                  >
                    Next
                  </button>
                </div>
              </div>
            </>
          )}
        </SectionCard>
      )}

      {!mode && executionNotice}

      {canUpdate && (
        <details className="campaign-help">
          <summary>How campaign preparation works</summary>
          <ol>
            <li>Create a draft and attach a message audio asset.</li>
            <li>Choose one or more contact groups as the intended audience.</li>
            <li>Run preflight to estimate currently eligible contacts.</li>
            <li>
              Execution remains unavailable. Drafts, schedules and preflight never place a call.
            </li>
          </ol>
        </details>
      )}
    </>
  );
}
