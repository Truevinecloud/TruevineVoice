/**
 * The single worker-side interpretation of a campaign's durable dispatch state.
 *
 * `campaign.status` and `campaign_execution.status` are not dispatch controls.
 * Only these explicit fields answer whether new paid work may begin.
 */
export interface CampaignDispatchStateRow {
  readonly status?: unknown;
  readonly dispatchState?: unknown;
  readonly emergencyStoppedAt?: unknown;
}

export type CampaignDispatchVerdict = 'running' | 'paused' | 'cancelled' | 'not_active';

export function dispatchVerdict(row: CampaignDispatchStateRow): CampaignDispatchVerdict {
  if (row.emergencyStoppedAt) return 'cancelled';
  if (row.dispatchState === 'CANCELLED' || row.status === 'CANCELLED') return 'cancelled';
  if (row.dispatchState === 'PAUSED' || row.status === 'PAUSED') return 'paused';
  if (row.status !== 'ACTIVE' && row.status !== undefined) return 'not_active';
  return 'running';
}
