'use client';

import { useEffect, useState } from 'react';

import { messageFor, request } from '../../../lib/api';
import type { Campaign } from '../../../lib/org-api';

interface Group {
  readonly id: string;
  readonly name: string;
}
interface AudioAsset {
  readonly id: string;
  readonly name: string;
}
interface Preflight {
  readonly valid: boolean;
  readonly eligibleContactCount: number;
  readonly issues: readonly { readonly code: string; readonly message: string }[];
}

/** Minimal draft editor. It prepares records only; it cannot launch or schedule execution. */
export function CampaignBuilder({
  organizationId,
  initialCampaigns,
  canUpdate,
}: {
  readonly organizationId: string;
  readonly initialCampaigns: readonly Campaign[];
  readonly canUpdate: boolean;
}): React.JSX.Element {
  const [campaigns, setCampaigns] = useState(initialCampaigns);
  const [groups, setGroups] = useState<readonly Group[]>([]);
  const [assets, setAssets] = useState<readonly AudioAsset[]>([]);
  const [selected, setSelected] = useState('');
  const [name, setName] = useState('');
  const [audioAssetId, setAudioAssetId] = useState('');
  const [audienceGroupIds, setAudienceGroupIds] = useState<string[]>([]);
  const [scheduledAt, setScheduledAt] = useState('');
  const [retryMaxAttempts, setRetryMaxAttempts] = useState(1);
  const [retryDelayMinutes, setRetryDelayMinutes] = useState(60);
  const [preflight, setPreflight] = useState<Preflight | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const base = `/organizations/${organizationId}`;

  useEffect(() => {
    let active = true;
    void Promise.all([
      request<readonly Group[]>(`${base}/contact-groups`),
      request<readonly AudioAsset[]>(`${base}/audio-assets`),
    ])
      .then(([groupRows, assetRows]) => {
        if (active) {
          setGroups(groupRows);
          setAssets(assetRows);
        }
      })
      .catch((cause: unknown) => {
        if (active) setError(messageFor(cause));
      });
    return () => {
      active = false;
    };
  }, [base]);

  function loadDraft(id: string): void {
    setSelected(id);
    const campaign = campaigns.find((item) => item.id === id);
    setName(campaign?.name ?? '');
    setAudioAssetId(campaign?.audioAssetId ?? '');
    setAudienceGroupIds([...(campaign?.audienceGroupIds ?? [])]);
    setScheduledAt(
      campaign?.scheduledAt ? new Date(campaign.scheduledAt).toISOString().slice(0, 16) : '',
    );
    setRetryMaxAttempts(campaign?.retryMaxAttempts ?? 1);
    setRetryDelayMinutes(campaign?.retryDelayMinutes ?? 60);
    setPreflight(null);
    setError('');
    setNotice('');
  }

  async function save(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError('');
    setNotice('');
    setPreflight(null);
    try {
      const body = {
        name,
        audioAssetId: audioAssetId || null,
        audienceGroupIds,
        scheduledAt: scheduledAt ? new Date(scheduledAt).toISOString() : null,
        retryMaxAttempts,
        retryDelayMinutes,
      };
      const campaign = await request<Campaign>(
        selected ? `${base}/campaigns/${selected}` : `${base}/campaigns`,
        {
          method: selected ? 'PATCH' : 'POST',
          body,
        },
      );
      setCampaigns((items) =>
        selected
          ? items.map((item) => (item.id === campaign.id ? campaign : item))
          : [campaign, ...items],
      );
      setSelected(campaign.id);
      setNotice('Draft saved. Run preflight to review readiness.');
    } catch (cause) {
      setError(messageFor(cause));
    } finally {
      setBusy(false);
    }
  }

  async function checkPreflight(): Promise<void> {
    if (!selected) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await request<Preflight>(`${base}/campaigns/${selected}/preflight`, {
        method: 'POST',
        body: {},
      });
      setPreflight(result);
      setNotice(
        result.valid
          ? `Preflight passed for ${result.eligibleContactCount} currently eligible contacts.`
          : 'Preflight found items to resolve.',
      );
    } catch (cause) {
      setError(messageFor(cause));
    } finally {
      setBusy(false);
    }
  }

  if (!canUpdate) return <p>Campaigns are read-only for your role.</p>;

  const selectedAudio = assets.find((asset) => asset.id === audioAssetId);
  const selectedGroups = groups.filter((group) => audienceGroupIds.includes(group.id));

  return (
    <section className="campaign-builder" aria-labelledby="campaign-builder-heading">
      <header className="campaign-builder__header">
        <div>
          <p className="campaign-builder__eyebrow">Campaign workspace</p>
          <h2 id="campaign-builder-heading">Build a campaign draft</h2>
          <p>Set up the message and audience, then review readiness before anything is prepared.</p>
        </div>
        <div className="campaign-builder__draft-picker">
          <label htmlFor="campaign-existing-draft">Continue a draft</label>
          <select
            id="campaign-existing-draft"
            value={selected}
            onChange={(event) => loadDraft(event.target.value)}
          >
            <option value="">Start a new campaign</option>
            {campaigns
              .filter((item) => item.status === 'DRAFT')
              .map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
          </select>
        </div>
      </header>

      {error && (
        <p className="campaign-builder__alert campaign-builder__alert--error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="campaign-builder__alert campaign-builder__alert--success" role="status">
          {notice}
        </p>
      )}

      <form className="campaign-builder__form" onSubmit={save}>
        <section className="campaign-builder__section" aria-labelledby="campaign-details-heading">
          <div className="campaign-builder__section-heading">
            <span className="campaign-builder__step">01</span>
            <div>
              <h3 id="campaign-details-heading">Campaign Details</h3>
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
              <h3 id="campaign-audio-heading">Message Audio</h3>
              <p>Choose the recorded or generated audio asset for this campaign.</p>
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
                  <span>Add or record audio in the Audio library before selecting it here.</span>
                </p>
              )}
            </div>
          </div>
        </section>

        <section className="campaign-builder__section" aria-labelledby="campaign-audience-heading">
          <div className="campaign-builder__section-heading">
            <span className="campaign-builder__step">03</span>
            <div>
              <h3 id="campaign-audience-heading">Target Audience</h3>
              <p>Select one or more contact groups. Eligibility is checked during preflight.</p>
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
              <h3 id="campaign-schedule-heading">Schedule &amp; Retry Settings</h3>
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
                onChange={(event) => setScheduledAt(event.target.value)}
                aria-describedby="campaign-scheduled-hint"
              />
              <span className="campaign-builder__hint" id="campaign-scheduled-hint">
                Use your local time. Choose a time at least 5 minutes ahead and within one year.
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
              />
              <span className="campaign-builder__hint" id="campaign-retry-attempts-hint">
                Includes the first attempt. Allowed range: 1–5.
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
                />
                <span>minutes</span>
              </div>
              <span className="campaign-builder__hint" id="campaign-retry-delay-hint">
                Allowed range: 5–1,440 minutes.
              </span>
            </div>
          </div>
        </section>

        <section className="campaign-builder__section" aria-labelledby="campaign-review-heading">
          <div className="campaign-builder__section-heading">
            <span className="campaign-builder__step">05</span>
            <div>
              <h3 id="campaign-review-heading">Review &amp; Preflight</h3>
              <p>
                Review your selections and check current readiness before saving or sharing the
                draft.
              </p>
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
              <dd>{scheduledAt ? new Date(scheduledAt).toLocaleString() : 'Not scheduled'}</dd>
            </div>
            <div>
              <dt>Retry policy</dt>
              <dd>
                {retryMaxAttempts} attempts, {retryDelayMinutes} minute delay
              </dd>
            </div>
          </dl>

          {preflight && (
            <div
              className={`campaign-builder__preflight ${preflight.valid ? 'is-valid' : 'has-issues'}`}
              aria-label="Preflight results"
              role="status"
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

          <p className="campaign-builder__safety-note">
            Preflight estimates current consented, unsuppressed contacts. It does not snapshot
            recipients, place calls, schedule execution or enable providers.
          </p>
          <div className="campaign-builder__actions">
            <button className="campaign-builder__save" type="submit" disabled={busy}>
              {busy ? 'Saving…' : 'Save Draft'}
            </button>
            <button
              className="campaign-builder__preflight-action"
              type="button"
              disabled={busy || !selected}
              onClick={() => void checkPreflight()}
            >
              {busy ? 'Checking…' : 'Run Preflight'}
            </button>
            {!selected && (
              <span className="campaign-builder__hint">Save the draft to run preflight.</span>
            )}
          </div>
        </section>
      </form>
    </section>
  );
}
