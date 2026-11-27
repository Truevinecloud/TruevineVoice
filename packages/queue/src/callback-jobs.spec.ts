import { describe, expect, it, vi } from 'vitest';

import { startCallbackJobs } from './callback-jobs.js';

const fake = vi.hoisted(() => ({
  addBulk: vi.fn(),
  callbacks: new Map<string, () => void>(),
  consume: vi.fn<(job: { data: { receiptId: string } }) => Promise<void>>(),
  close: vi.fn(),
}));

vi.mock('bullmq', () => ({
  Queue: class {
    addBulk = fake.addBulk;
    close = fake.close;
    on = (name: string, callback: () => void) => fake.callbacks.set('queue:' + name, callback);
  },
  Worker: class {
    constructor(_name: string, callback: typeof fake.consume) {
      fake.consume.mockImplementation(callback);
    }
    close = fake.close;
    on = (name: string, callback: () => void) => fake.callbacks.set('worker:' + name, callback);
  },
}));

describe('voice callback queue', () => {
  it('can reoffer the same durable receipt after Redis interruption', async () => {
    const process = vi.fn(async () => undefined);
    const report = vi.fn();
    const jobs = startCallbackJobs({ connection: {} }, process, report);
    fake.addBulk.mockRejectedValueOnce(new Error('unavailable')).mockResolvedValueOnce([]);
    await expect(jobs.enqueue(['receipt-id'])).rejects.toThrow('unavailable');
    await jobs.enqueue(['receipt-id']);
    const job = { name: 'process', data: { receiptId: 'receipt-id' }, opts: { jobId: 'receipt-id' } };
    expect(fake.addBulk).toHaveBeenNthCalledWith(1, [job]);
    expect(fake.addBulk).toHaveBeenNthCalledWith(2, [job]);
    await fake.consume(job);
    expect(process).toHaveBeenCalledWith('receipt-id');
    fake.callbacks.get('worker:failed')?.();
    expect(report).toHaveBeenCalledOnce();
    await jobs.close();
    expect(fake.close).toHaveBeenCalledTimes(2);
  });
});
