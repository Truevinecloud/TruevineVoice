import { describe, expect, it } from 'vitest';

import { CAMPAIGN_EXECUTION_QUEUE, createCampaignExecutionQueue } from './campaign-execution.js';

describe('campaign execution queue', () => {
  it('uses a stable queue name', () => {
    expect(CAMPAIGN_EXECUTION_QUEUE).toBe('campaign-execution');
  });

  it('creates a queue with the supplied connection', () => {
    const queue = createCampaignExecutionQueue({ connection: { url: 'redis://localhost:6379' } as never });
    expect(queue.name).toBe(CAMPAIGN_EXECUTION_QUEUE);
    expect(queue.opts.defaultJobOptions).toMatchObject({
      attempts: 3,
      backoff: { type: 'exponential', delay: 1_000 },
    });
  });

  it('supports an isolated queue name and explicit retry policy', () => {
    const queue = createCampaignExecutionQueue(
      { connection: { url: 'redis://localhost:56379' } as never },
      { queueName: 'w402-test-queue', maxAttempts: 4, retryBackoffMs: 250 },
    );

    expect(queue.name).toBe('w402-test-queue');
    expect(queue.opts.defaultJobOptions).toMatchObject({
      attempts: 4,
      backoff: { type: 'exponential', delay: 250 },
    });
  });
});