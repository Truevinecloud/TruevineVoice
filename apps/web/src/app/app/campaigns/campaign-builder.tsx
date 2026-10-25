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
  return (
    <section className="card-section" aria-labelledby="campaign-builder-heading">
      <h2 id="campaign-builder-heading">Campaign draft</h2>
      <label>
        Existing draft{' '}
        <select value={selected} onChange={(event) => loadDraft(event.target.value)}>
          <option value="">New campaign</option>
          {campaigns
            .filter((item) => item.status === 'DRAFT')
            .map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
        </select>
      </label>
      <form onSubmit={save}>
        <label>
          Campaign name{' '}
          <input
            required
            maxLength={200}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <label>
          Message audio{' '}
          <select value={audioAssetId} onChange={(event) => setAudioAssetId(event.target.value)}>
            <option value="">Select audio</option>
            {assets.map((asset) => (
              <option key={asset.id} value={asset.id}>
                {asset.name}
              </option>
            ))}
          </select>
        </label>
        <fieldset>
          <legend>Audience contact groups</legend>
          {groups.length === 0 ? (
            <p>Create a contact group before building an audience.</p>
          ) : (
            groups.map((group) => (
              <label key={group.id}>
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
                />{' '}
                {group.name}
              </label>
            ))
          )}
        </fieldset>
        <label>
          Schedule (your local time){' '}
          <input
            type="datetime-local"
            value={scheduledAt}
            onChange={(event) => setScheduledAt(event.target.value)}
          />
        </label>
        <label>
          Maximum attempts (including first){' '}
          <input
            type="number"
            min={1}
            max={5}
            value={retryMaxAttempts}
            onChange={(event) => setRetryMaxAttempts(Number(event.target.value))}
          />
        </label>
        <label>
          Retry delay in minutes{' '}
          <input
            type="number"
            min={5}
            max={1440}
            value={retryDelayMinutes}
            onChange={(event) => setRetryDelayMinutes(Number(event.target.value))}
          />
        </label>
        <button type="submit" disabled={busy}>
          {busy ? 'Saving…' : 'Save draft'}
        </button>
        {selected && (
          <button type="button" disabled={busy} onClick={() => void checkPreflight()}>
            Run preflight
          </button>
        )}
      </form>
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      {preflight && (
        <ul aria-label="Preflight results">
          {preflight.issues.map((issue) => (
            <li key={issue.code}>{issue.message}</li>
          ))}
        </ul>
      )}
      <p className="field-hint">
        Preflight estimates current consented, unsuppressed contacts. It does not snapshot
        recipients, place calls, schedule execution or enable providers.
      </p>
    </section>
  );
}
