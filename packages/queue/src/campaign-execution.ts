import { Queue } from 'bullmq';
import type { BullConnectionOptions } from './index.js';

export const CAMPAIGN_EXECUTION_QUEUE = 'campaign-execution';

export interface CampaignExecutionJobData {
  readonly organizationId: string;
  readonly campaignId: string;
  /**
   * Optional dispatch generation captured when the job was enqueued. A stale
   * job is refused after pause/resume; older jobs without this field still go
   * through the authoritative dispatch guard before any paid work.
   */
  readonly dispatchEpoch?: number;
}

export interface CampaignExecutionQueueOptions {
  readonly queueName?: string;
  readonly maxAttempts?: number;
  readonly retryBackoffMs?: number;
}

export function createCampaignExecutionQueue(
  connection: BullConnectionOptions,
  options: CampaignExecutionQueueOptions = {},
): Queue<CampaignExecutionJobData> {
  const queueName = options.queueName ?? CAMPAIGN_EXECUTION_QUEUE;
  const maxAttempts = options.maxAttempts ?? 3;
  const retryBackoffMs = options.retryBackoffMs ?? 1_000;

  if (!queueName.trim()) throw new Error('campaign_execution_queue_name_required');
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error('campaign_execution_max_attempts_invalid');
  }
  if (!Number.isInteger(retryBackoffMs) || retryBackoffMs < 1) {
    throw new Error('campaign_execution_retry_backoff_invalid');
  }

  return new Queue<CampaignExecutionJobData>(queueName, {
    ...connection,
    defaultJobOptions: {
      attempts: maxAttempts,
      backoff: { type: 'exponential', delay: retryBackoffMs },
      removeOnComplete: 100,
      removeOnFail: 100,
    },
  });
}