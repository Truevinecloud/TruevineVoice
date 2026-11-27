import { Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { createDatabaseClient } from '@truevine/database';
import { createBullConnectionOptions, startCallbackJobs } from '@truevine/queue';
import { CallbackReceipts } from '@truevine/telephony';

import { UsageSettlement } from './usage-settlement/usage-settlement.js';

@Injectable()
export class CallbackWorker implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(CallbackWorker.name);
  private db?: ReturnType<typeof createDatabaseClient>;
  private jobs?: ReturnType<typeof startCallbackJobs>;
  private timer?: NodeJS.Timeout;
  private scan?: Promise<void> | undefined;

  onApplicationBootstrap() {
    const databaseUrl = process.env['VOICE_CALLBACK_DATABASE_URL'];
    if (!databaseUrl) return;
    const redisUrl = process.env['REDIS_URL'];
    if (!redisUrl) throw new Error('Callback worker Redis configuration is missing.');
    this.db = createDatabaseClient(databaseUrl, { log: [] });
    const receipts = new CallbackReceipts(this.db, {
      settlement: new UsageSettlement(),
    });
    const reportFailure = () => this.logger.warn('voice_callback_job_failed');
    const jobs = startCallbackJobs(
      createBullConnectionOptions(redisUrl),
      async (id) => {
        try {
          await receipts.process(id);
        } catch {
          throw new Error('voice_callback_processing_unavailable');
        }
      },
      reportFailure,
    );
    this.jobs = jobs;
    const dispatch = () => {
      if (this.scan) return;
      this.scan = receipts.due().then(async (ids) => {
        if (ids.length) await jobs.enqueue(ids);
      }).catch(reportFailure).finally(() => { this.scan = undefined; });
    };
    this.timer = setInterval(dispatch, 5_000);
    dispatch();
  }

  async onApplicationShutdown() {
    if (this.timer) clearInterval(this.timer);
    try {
      await this.scan;
      await this.jobs?.close();
    } finally {
      await this.db?.$disconnect();
    }
  }
}
