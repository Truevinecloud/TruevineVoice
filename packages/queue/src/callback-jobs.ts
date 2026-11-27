import { Queue, Worker } from 'bullmq';

import type { BullConnectionOptions } from './index.js';

const QUEUE = 'voice-callback-receipts';

interface CallbackJob {
  receiptId: string;
}

export function startCallbackJobs(
  options: BullConnectionOptions,
  processReceipt: (receiptId: string) => Promise<void>,
  reportFailure: () => void,
) {
  const queue = new Queue<CallbackJob>(QUEUE, {
    ...options,
    connection: { ...options.connection, enableOfflineQueue: false, maxRetriesPerRequest: 1 },
    defaultJobOptions: { removeOnComplete: true, removeOnFail: true },
  });
  const worker = new Worker<CallbackJob>(QUEUE, ({ data }) => processReceipt(data.receiptId), options);
  queue.on('error', reportFailure);
  worker.on('error', reportFailure);
  worker.on('failed', reportFailure);
  return {
    async enqueue(ids: readonly string[]) {
      await queue.addBulk(ids.map((receiptId) => ({
        name: 'process',
        data: { receiptId },
        opts: { jobId: receiptId },
      })));
    },
    async close() {
      await worker.close();
      await queue.close();
    },
  };
}
