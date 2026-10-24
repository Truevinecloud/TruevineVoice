'use client';

import { useEffect, useState } from 'react';
import { messageFor, request } from '../../../lib/api';

interface Asset {
  id: string;
  name: string;
  source: string;
}
interface Campaign {
  id: string;
  audioAssetId?: string | null;
  name: string;
}

export function CampaignAudio({
  organizationId,
  campaign,
  canUpdate,
}: {
  organizationId: string;
  campaign: Campaign;
  canUpdate: boolean;
}): React.JSX.Element {
  const [assets, setAssets] = useState<Asset[]>([]);
  const [selected, setSelected] = useState(campaign.audioAssetId ?? '');
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    void request<Asset[]>(`/organizations/${organizationId}/audio-assets`)
      .then(setAssets)
      .catch((cause: unknown) => setError(messageFor(cause)));
  }, [organizationId]);
  async function save(): Promise<void> {
    setError('');
    setSaved(false);
    try {
      await request(`/organizations/${organizationId}/campaigns/${campaign.id}`, {
        method: 'PATCH',
        body: { audioAssetId: selected || null },
      });
      setSaved(true);
    } catch (cause) {
      setError(messageFor(cause));
    }
  }
  return (
    <div>
      {canUpdate ? (
        <>
          <label htmlFor={`audio-${campaign.id}`}>Campaign audio</label>
          <select
            id={`audio-${campaign.id}`}
            value={selected}
            onChange={(event) => setSelected(event.target.value)}
          >
            <option value="">No audio selected</option>
            {assets.map((asset) => (
              <option key={asset.id} value={asset.id}>
                {asset.name} ({asset.source})
              </option>
            ))}
          </select>
          <button type="button" onClick={() => void save()}>
            Save audio
          </button>
        </>
      ) : (
        <span>{campaign.audioAssetId ? 'Audio selected' : 'No audio selected'}</span>
      )}
      {error && <p role="alert">{error}</p>}
      {saved && <p role="status">Campaign audio selection saved.</p>}
    </div>
  );
}
