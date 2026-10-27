'use client';

import { useState } from 'react';

import { messageFor, request } from '../../../lib/api';
import {
  isoFromLocalDateTime,
  localDateTimeValue,
  maximumScheduleValue,
  minimumScheduleValue,
} from '../../../lib/datetime';
import type { Campaign } from '../../../lib/org-api';

export interface CampaignGroup {
  readonly id: string;
  readonly name: string;
}
export interface CampaignAudioAsset {
  readonly id: string;
  readonly name: string;
}

/**
 * Draft editor.
 *
 * It prepares a record only. It cannot launch, schedule execution or place a
 * call, and it never asks a provider to do anything. The audience and audio
 * lists are supplied by the workspace so a draft can be prepared without a
 * request per row.
 *
 * Times are converted in exactly one place (`lib/datetime`). Submitting the raw
 * `datetime-local` value would send an instant with no offset, and reading a
 * stored instant with `toISOString()` would show UTC in a control the operator
 * reads as local time.
 */
export function CampaignBuilder({
  organizationId,
  campaign,
  groups,
  assets,
  onSaved,
  onCancel,
}: {
  readonly organizationId: string;
  readonly campaign: Campaign | null;
  readonly groups: readonly CampaignGroup[];
  readonly assets: readonly CampaignAudioAsset[];
  readonly onSaved: (campaign: Campaign) => void;
  readonly onCancel: () => void;
}): React.JSX.Element {
  const [name, setName] = useState(campaign?.name ?? '');
  const [audioAssetId, setAudioAssetId] = useState(campaign?.audioAssetId ?? '');
  const [audienceGroupIds, setAudienceGroupIds] = useState<string[]>([
    ...(campaign?.audienceGroupIds ?? []),
  ]);
  const [scheduledAt, setScheduledAt] = useState(localDateTimeValue(campaign?.scheduledAt));
  const [retryMaxAttempts, setRetryMaxAttempts] = useState(campaign?.retryMaxAttempts ?? 1);
  const [retryDelayMinutes, setRetryDelayMinutes] = useState(campaign?.retryDelayMinutes ?? 60);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const base = `/organizations/${encodeURIComponent(organizationId)}/campaigns`;

  async function save(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const body = {
        name: name.trim(),
        audioAssetId: audioAssetId || null,
        audienceGroupIds,
        scheduledAt: isoFromLocalDateTime(scheduledAt),
        retryMaxAttempts,
        retryDelayMinutes,
      };
      const saved = await request<Campaign>(
        campaign ? `${base}/${encodeURIComponent(campaign.id)}` : base,
        { method: campaign ? 'PATCH' : 'POST', body },
      );
      onSaved(saved);
    } catch (cause) {
      setError(messageFor(cause));
    } finally {
      setBusy(false);
    }
  }

  const selectedAudio = assets.find((asset) => asset.id === audioAssetId);
  const selectedGroups = groups.filter((group) => audienceGroupIds.includes(group.id));

  return (
    <section className="campaign-builder" aria-labelledby="campaign-builder-heading">
      <header className="campaign-builder__header">
        <div>
          <p className="campaign-builder__eyebrow">Campaign workspace</p>
          <h2 id="campaign-builder-heading">
            {campaign ? 'Edit campaign draft' : 'Build a campaign draft'}
          </h2>
          <p>
            Set up the message and audience, then save the draft and review its readiness. This
            workspace prepares a record; it does not place calls.
          </p>
        </div>
        <button className="campaign-builder__cancel" type="button" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
      </header>

      {error && (
        <p className="campaign-builder__alert campaign-builder__alert--error" role="alert">
          {error}
        </p>
      )}

      <form className="campaign-builder__form" onSubmit={save} noValidate={false}>
        <section className="campaign-builder__section" aria-labelledby="campaign-details-heading">
          <div className="campaign-builder__section-heading">
            <span className="campaign-builder__step">01</span>
            <div>
              <h3 id="campaign-details-heading">Campaign details</h3>
              <p>Give this draft a clear name so your team can find it later.</p>
            </div>
          </div>
          <div className="campaign-builder__grid">
            <div className="campaign-builder__field campaign-builder__field--wide">
              <label htmlFor="campaign-name">Campaign name</label>
              <input
                id="campaign-name"
                required
                maxLength={200}
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="For example, October member follow-up"
                aria-describedby="campaign-name-hint"
                disabled={busy}
              />
              <span className="campaign-builder__hint" id="campaign-name-hint">
                Up to 200 characters.
              </span>
            </div>
          </div>
        </section>

        <section className="campaign-builder__section" aria-labelledby="campaign-audio-heading">
          <div className="campaign-builder__section-heading">
            <span className="campaign-builder__step">02</span>
            <div>
              <h3 id="campaign-audio-heading">Message audio</h3>
              <p>Choose a recorded or generated audio asset for this campaign.</p>
            </div>
          </div>
          <div className="campaign-builder__grid">
            <div className="campaign-builder__field campaign-builder__field--wide">
              <label htmlFor="campaign-audio">Message audio</label>
              <select
                id="campaign-audio"
                value={audioAssetId}
                onChange={(event) => setAudioAssetId(event.target.value)}
                aria-describedby="campaign-audio-hint"
                disabled={busy}
              >
                <option value="">Select an audio asset</option>
                {assets.map((asset) => (
                  <option key={asset.id} value={asset.id}>
                    {asset.name}
                  </option>
                ))}
              </select>
              <span className="campaign-builder__hint" id="campaign-audio-hint">
                Audio is attached to the draft only. No call is placed.
              </span>
              {assets.length === 0 && (
                <p className="campaign-builder__empty" role="status">
                  <strong>No audio assets yet</strong>
                  <span>
                    Audio storage and text to speech are not configured in every environment. Add
                    or record audio in the Audio library before selecting it here.
                  </span>
                </p>
              )}
            </div>
          </div>
        </section>

        <section className="campaign-builder__section" aria-labelledby="campaign-audience-heading">
          <div className="campaign-builder__section-heading">
            <span className="campaign-builder__step">03</span>
            <div>
              <h3 id="campaign-audience-heading">Target audience</h3>
              <p>
                Select one or more contact groups. Eligibility, consent and suppression are checked
                during preflight, not assumed here.
              </p>
            </div>
          </div>
          <fieldset className="campaign-builder__choice-group">
            <legend>Contact groups</legend>
            {groups.length === 0 ? (
              <p className="campaign-builder__empty" role="status">
                <strong>No contact groups available</strong>
                <span>Create a group in Contacts to use it as a campaign audience.</span>
              </p>
            ) : (
              <div className="campaign-builder__group-list">
                {groups.map((group) => (
                  <label className="campaign-builder__group-option" key={group.id}>
                    <input
                      type="checkbox"
                      checked={audienceGroupIds.includes(group.id)}
                      disabled={busy}
                      onChange={(event) =>
                        setAudienceGroupIds((ids) =>
                          event.target.checked
                            ? [...ids, group.id]
                            : ids.filter((id) => id !== group.id),
                        )
                      }
                    />
                    <span>{group.name}</span>
                  </label>
                ))}
              </div>
            )}
          </fieldset>
        </section>

        <section className="campaign-builder__section" aria-labelledby="campaign-schedule-heading">
          <div className="campaign-builder__section-heading">
            <span className="campaign-builder__step">04</span>
            <div>
              <h3 id="campaign-schedule-heading">Schedule &amp; retry settings</h3>
              <p>These settings are saved to the draft. Scheduling does not start execution.</p>
            </div>
          </div>
          <div className="campaign-builder__grid">
            <div className="campaign-builder__field">
              <label htmlFor="campaign-scheduled-at">Scheduled date and time</label>
              <input
                id="campaign-scheduled-at"
                type="datetime-local"
                value={scheduledAt}
                min={minimumScheduleValue()}
                max={maximumScheduleValue()}
                onChange={(event) => setScheduledAt(event.target.value)}
                aria-describedby="campaign-scheduled-hint"
                disabled={busy}
              />
              <span className="campaign-builder__hint" id="campaign-scheduled-hint">
                Shown and saved in your local time. Choose a time at least 5 minutes ahead and within
                one year.
              </span>
            </div>
            <div className="campaign-builder__field">
              <label htmlFor="campaign-retry-attempts">Maximum attempts</label>
              <input
                id="campaign-retry-attempts"
                type="number"
                min={1}
                max={5}
                value={retryMaxAttempts}
                onChange={(event) => setRetryMaxAttempts(Number(event.target.value))}
                aria-describedby="campaign-retry-attempts-hint"
                disabled={busy}
              />
              <span className="campaign-builder__hint" id="campaign-retry-attempts-hint">
                Includes the first attempt. Allowed range: 1 to 5.
              </span>
            </div>
            <div className="campaign-builder__field">
              <label htmlFor="campaign-retry-delay">Retry delay</label>
              <div className="campaign-builder__input-unit">
                <input
                  id="campaign-retry-delay"
                  type="number"
                  min={5}
                  max={1440}
                  value={retryDelayMinutes}
                  onChange={(event) => setRetryDelayMinutes(Number(event.target.value))}
                  aria-describedby="campaign-retry-delay-hint"
                  disabled={busy}
                />
                <span>minutes</span>
              </div>
              <span className="campaign-builder__hint" id="campaign-retry-delay-hint">
                Allowed range: 5 to 1,440 minutes.
              </span>
            </div>
          </div>
        </section>

        <section className="campaign-builder__section" aria-labelledby="campaign-review-heading">
          <div className="campaign-builder__section-heading">
            <span className="campaign-builder__step">05</span>
            <div>
              <h3 id="campaign-review-heading">Review before saving</h3>
              <p>Check the selections below. Saving stores a draft record only.</p>
            </div>
          </div>
          <dl className="campaign-builder__review">
            <div>
              <dt>Campaign</dt>
              <dd>{name.trim() || 'Name not set'}</dd>
            </div>
            <div>
              <dt>Message audio</dt>
              <dd>{selectedAudio?.name ?? 'No audio selected'}</dd>
            </div>
            <div>
              <dt>Audience</dt>
              <dd>
                {selectedGroups.length > 0
                  ? selectedGroups.map((group) => group.name).join(', ')
                  : 'No contact groups selected'}
              </dd>
            </div>
            <div>
              <dt>Schedule</dt>
              <dd>
                {scheduledAt
                  ? new Intl.DateTimeFormat(undefined, {
                      dateStyle: 'medium',
                      timeStyle: 'short',
                    }).format(new Date(scheduledAt))
                  : 'Not scheduled'}
              </dd>
            </div>
            <div>
              <dt>Retry policy</dt>
              <dd>
                {retryMaxAttempts} attempts, {retryDelayMinutes} minute delay
              </dd>
            </div>
          </dl>

          <p className="campaign-builder__safety-note">
            Saving never places a call, snapshots recipients, or starts a provider. Preflight is a
            current estimate of consented, unsuppressed contacts.
          </p>
          <div className="campaign-builder__actions">
            <button className="campaign-builder__save" type="submit" disabled={busy}>
              {busy ? 'Saving…' : campaign ? 'Save changes' : 'Save draft'}
            </button>
            <button
              className="campaign-builder__preflight-action"
              type="button"
              onClick={onCancel}
              disabled={busy}
            >
              Cancel
            </button>
          </div>
        </section>
      </form>
    </section>
  );
}
