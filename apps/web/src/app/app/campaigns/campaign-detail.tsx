'use client';

import { useState } from 'react';

import { messageFor, request } from '../../../lib/api';
import { campaignStatusLabel, campaignStatusTone, isDraft } from '../../../lib/campaigns';
import { formatDateTime } from '../../../lib/datetime';
import type { Campaign } from '../../../lib/org-api';
import { StatusBadge } from '../AppUI';
import type { CampaignAudioAsset, CampaignGroup } from './campaign-builder';

interface Preflight {
  readonly valid: boolean;
  readonly eligibleContactCount: number;
  readonly issues: readonly { readonly code: string; readonly message: string }[];
}

/**
 * Read-only review of one campaign record with the two draft actions that exist
 * today: preflight and deletion. It deliberately has no launch action, because
 * campaign execution is not implemented.
 */
export function CampaignDetail({
  organizationId,
  campaign,
  groups,
  assets,
  canUpdate,
  canDelete,
  onEdit,
  onDeleted,
  onClose,
}: {
  readonly organizationId: string;
  readonly campaign: Campaign;
  readonly groups: readonly CampaignGroup[];
  readonly assets: readonly CampaignAudioAsset[];
  readonly canUpdate: boolean;
  readonly canDelete: boolean;
  readonly onEdit: () => void;
  readonly onDeleted: (campaignId: string) => void;
  readonly onClose: () => void;
}): React.JSX.Element {
  const [preflight, setPreflight] = useState<Preflight | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState<'preflight' | 'delete' | null>(null);
  const [error, setError] = useState('');
  const draft = isDraft(campaign);
  const base = `/organizations/${encodeURIComponent(organizationId)}/campaigns/${encodeURIComponent(campaign.id)}`;
  const audience =
    campaign.audienceGroupIds && campaign.audienceGroupIds.length > 0
      ? campaign.audienceGroupIds.map(
          (id) => groups.find((group) => group.id === id)?.name ?? 'Unavailable group',
        )
      : [];
  const audio = assets.find((asset) => asset.id === campaign.audioAssetId);

  async function checkPreflight(): Promise<void> {
    setBusy('preflight');
    setError('');
    try {
      setPreflight(
        await request<Preflight>(`${base}/preflight`, {
          method: 'POST',
          body: {},
        }),
      );
    } catch (cause) {
      setError(messageFor(cause));
    } finally {
      setBusy(null);
    }
  }

  async function remove(): Promise<void> {
    setBusy('delete');
    setError('');
    try {
      await request(`${base}`, { method: 'DELETE' });
      onDeleted(campaign.id);
    } catch (cause) {
      setError(messageFor(cause));
      setConfirming(false);
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="campaign-detail" aria-labelledby="campaign-detail-heading">
      <header className="campaign-detail__header">
        <div>
          <p className="campaign-detail__eyebrow">Campaign review</p>
          <h2 id="campaign-detail-heading">{campaign.name}</h2>
          <StatusBadge tone={campaignStatusTone(campaign.status)}>
            {campaignStatusLabel(campaign.status)}
          </StatusBadge>
        </div>
        <div className="campaign-detail__header-actions">
          {draft && canUpdate && (
            <button className="button-secondary" type="button" onClick={onEdit}>
              Edit draft
            </button>
          )}
          {draft && canDelete && (
            <button
              className="button-secondary button-danger"
              type="button"
              onClick={() => {
                setConfirming(true);
                setError('');
              }}
              disabled={busy !== null}
            >
              Delete draft
            </button>
          )}
          <button className="button-secondary" type="button" onClick={onClose}>
            Close
          </button>
        </div>
      </header>

      {error && (
        <p className="notice notice-error campaign-detail__notice" role="alert">
          {error}
        </p>
      )}

      <dl className="campaign-detail__facts">
        <div>
          <dt>Message audio</dt>
          <dd>
            {audio?.name ??
              (campaign.audioAssetId ? 'Audio asset unavailable' : 'No audio selected')}
          </dd>
        </div>
        <div>
          <dt>Audience</dt>
          <dd>{audience.length > 0 ? audience.join(', ') : 'No contact groups selected'}</dd>
        </div>
        <div>
          <dt>Scheduled</dt>
          <dd>{formatDateTime(campaign.scheduledAt)}</dd>
        </div>
        <div>
          <dt>Retry policy</dt>
          <dd>
            {campaign.retryMaxAttempts ?? 1} attempts, {campaign.retryDelayMinutes ?? 60} minute
            delay
          </dd>
        </div>
        <div>
          <dt>Created</dt>
          <dd>{formatDateTime(campaign.createdAt)}</dd>
        </div>
        <div>
          <dt>Last updated</dt>
          <dd>{formatDateTime(campaign.updatedAt)}</dd>
        </div>
      </dl>

      {draft ? (
        <div className="campaign-detail__draft">
          <div>
            <h3>Readiness</h3>
            <p>
              Preflight estimates how many contacts are currently consented and not suppressed. It
              does not snapshot recipients or place calls.
            </p>
            {canUpdate ? (
              <button
                className="button-secondary"
                type="button"
                onClick={() => void checkPreflight()}
                disabled={busy !== null}
              >
                {busy === 'preflight' ? 'Checking readiness…' : 'Run preflight'}
              </button>
            ) : (
              <p className="field-hint">Your role cannot run preflight.</p>
            )}
          </div>
          {preflight && (
            <div
              className={`campaign-builder__preflight ${preflight.valid ? 'is-valid' : 'has-issues'}`}
              role="status"
              aria-label="Preflight results"
            >
              <strong>
                {preflight.valid ? 'Ready for review' : 'Resolve these items before proceeding'}
              </strong>
              <p>{preflight.eligibleContactCount} currently eligible contacts</p>
              {preflight.issues.length > 0 && (
                <ul>
                  {preflight.issues.map((issue) => (
                    <li key={issue.code}>{issue.message}</li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      ) : (
        <p className="notice notice-info campaign-detail__notice">
          Only draft records can be edited, deleted or sent to preflight. This record is kept as a
          campaign record and cannot be changed here.
        </p>
      )}

      {confirming && (
        <div className="campaign-detail__confirm" role="alertdialog" aria-modal="false">
          <h3>Delete “{campaign.name}”?</h3>
          <p>
            This deletes the draft record only. It cannot be undone, and any campaign history
            already recorded is not altered.
          </p>
          <div className="campaign-detail__confirm-actions">
            <button
              className="button-secondary button-danger"
              type="button"
              onClick={() => void remove()}
              disabled={busy !== null}
            >
              {busy === 'delete' ? 'Deleting…' : 'Yes, delete this draft'}
            </button>
            <button
              className="button-secondary"
              type="button"
              onClick={() => setConfirming(false)}
              disabled={busy !== null}
            >
              Keep draft
            </button>
          </div>
        </div>
      )}

      <p className="campaign-detail__safety">
        Campaign execution, call attempts and delivery outcomes are not available yet. Reviewing or
        deleting a draft does not contact anyone and does not activate telephony, text to speech or
        any paid provider.
      </p>
    </section>
  );
}
