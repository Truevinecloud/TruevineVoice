import { Inject, Injectable, Logger } from '@nestjs/common';
import { Worker } from 'bullmq';
import type { PrismaClient } from '@truevine/database';

import { CAMPAIGN_EXECUTION_QUEUE, type CampaignExecutionJobData, createBullConnection } from '@truevine/queue';
import { dispatchVerdict } from '../reliability/dispatch-state.js';
import { CampaignCallInitiationService, type InitiationResult } from './campaign-call-initiation.service.js';
import { WORKER_CONFIG } from '../config/worker-config.module.js';
import type { WorkerConfig } from '../config/worker.config.js';
import { DATABASE_CLIENT, REDIS_CLIENT } from '../tokens.js';

const QUEUE_NAME = process.env['CAMPAIGN_EXECUTION_QUEUE_NAME'] ?? CAMPAIGN_EXECUTION_QUEUE;

export type CampaignExecutionMode = 'disabled' | 'w402-test' | 'w601-test' | 'local';
export const CAMPAIGN_EXECUTION_MODE = Symbol('CAMPAIGN_EXECUTION_MODE');

type CampaignExecutionProcessorResult =
  | {
      readonly status:
        | 'missing'
        | 'already_completed'
        | 'cancelled'
        | 'paused'
        | 'not_active'
        | 'stale_epoch'
        | 'eligible'
        | 'no_recipients';
    }
  | {
      readonly status: 'processed' | 'reconciliation_required';
      readonly recipientCount: number;
      readonly outcomes: ReadonlyArray<{ readonly recipientId: string; readonly result: InitiationResult }>;
    };

const ISOLATED_TEST_TARGETS = {
  'w402-test': {
    database: '/truevine_w402_integration_test',
    databasePort: '55432',
    redisPort: '56379',
    queuePrefix: 'w402-',
  },
  'w601-test': {
    database: '/truevine_w601_qa',
    databasePort: '55434',
    redisPort: '56382',
    queuePrefix: 'w601-',
  },
} as const;

function assertIsolatedTestEnvironment(
  mode: keyof typeof ISOLATED_TEST_TARGETS,
  config: WorkerConfig | undefined,
): void {
  const target = ISOLATED_TEST_TARGETS[mode];
  const queueName = process.env['CAMPAIGN_EXECUTION_QUEUE_NAME'];
  let database: URL;
  let redis: URL;
  try {
    database = new URL(config?.databaseUrl ?? '');
    redis = new URL(config?.redisUrl ?? '');
  } catch {
    throw new Error(`${mode} execution requires valid isolated database and Redis URLs.`);
  }

  const loopbackHosts = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
  if (
    process.env['NODE_ENV'] !== 'test' ||
    config?.environment !== 'test' ||
    !['postgres:', 'postgresql:'].includes(database.protocol) ||
    !loopbackHosts.has(database.hostname) ||
    database.port !== target.databasePort ||
    database.pathname !== target.database ||
    !['redis:', 'rediss:'].includes(redis.protocol) ||
    !loopbackHosts.has(redis.hostname) ||
    redis.port !== target.redisPort ||
    !queueName?.startsWith(target.queuePrefix) ||
    queueName !== QUEUE_NAME
  ) {
    throw new Error(
      `${mode} execution requires the local ${target.database.slice(1)} database, ` +
        `Redis on port ${target.redisPort}, and a unique ${target.queuePrefix}* queue.`,
    );
  }
}

@Injectable()
export class CampaignExecutionProcessor {
  private readonly logger = new Logger(CampaignExecutionProcessor.name);
  private worker?: Worker<CampaignExecutionJobData>;

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: unknown,
    @Inject(DATABASE_CLIENT) private readonly prisma: PrismaClient,
    @Inject(WORKER_CONFIG) private readonly config?: WorkerConfig,
    @Inject(CampaignCallInitiationService)
    private readonly callInitiation?: CampaignCallInitiationService,
    @Inject(CAMPAIGN_EXECUTION_MODE)
    private readonly executionMode: CampaignExecutionMode = 'disabled',
  ) {}

  onApplicationBootstrap(): void {
    if (this.executionMode === 'w402-test' || this.executionMode === 'w601-test') {
      assertIsolatedTestEnvironment(this.executionMode, this.config);
    }
    this.worker = new Worker<CampaignExecutionJobData>(
      QUEUE_NAME,
      async (job) => this.process(job.data),
      {
        ...createBullConnection(this.redis as never),
        concurrency: this.config?.workerConcurrency ?? 4,
        limiter: {
          max: this.config?.rateLimitMax ?? 10,
          duration: this.config?.rateLimitDurationMs ?? 1000,
        },
        ...(this.executionMode === 'w402-test' ||
        this.executionMode === 'w601-test' ||
        this.executionMode === 'local'
          ? { lockDuration: 2_000, stalledInterval: 500 }
          : {}),
      },
    );
  }

  async waitUntilReady(): Promise<void> {
    if (!this.worker) throw new Error('campaign_execution_worker_not_started');
    await this.worker.waitUntilReady();
  }

  async onApplicationShutdown(): Promise<void> {
    await this.worker?.close();
  }

  async process(data: CampaignExecutionJobData): Promise<CampaignExecutionProcessorResult> {
    if (this.executionMode === 'w402-test' || this.executionMode === 'w601-test') {
      assertIsolatedTestEnvironment(this.executionMode, this.config);
    }
    if (!data?.organizationId || !data?.campaignId) {
      throw new Error('Invalid campaign execution job payload');
    }

    const execution = await (this.prisma as unknown as {
      campaignExecution: { findUnique(input: unknown): Promise<Record<string, unknown> | null> };
    }).campaignExecution.findUnique({
      where: { organizationId_campaignId: { organizationId: data.organizationId, campaignId: data.campaignId } },
    });

    if (!execution) {
      this.logger.warn(`Missing campaign execution ${data.organizationId}/${data.campaignId}`);
      return { status: 'missing' };
    }

    // Queued, delayed and retried jobs all pass through this point. A status
    // change is never the control; the authoritative dispatch fields are.
    const campaignRow = await (this.prisma as unknown as {
      campaign: {
        findUnique(input: unknown): Promise<Record<string, unknown> | null>;
      };
    }).campaign.findUnique({
      where: {
        organizationId_id: { organizationId: data.organizationId, id: data.campaignId },
      },
      select: {
        status: true,
        dispatchState: true,
        dispatchEpoch: true,
        emergencyStoppedAt: true,
      },
    });
    if (!campaignRow) return { status: 'missing' };

    const verdict = dispatchVerdict({
      status: campaignRow.status,
      dispatchState: campaignRow.dispatchState,
      emergencyStoppedAt: campaignRow.emergencyStoppedAt,
    });
    if (verdict !== 'running') return { status: verdict };
    if (
      typeof data.dispatchEpoch === 'number' &&
      typeof campaignRow.dispatchEpoch === 'number' &&
      data.dispatchEpoch !== campaignRow.dispatchEpoch
    ) {
      return { status: 'stale_epoch' };
    }

    if (
      this.executionMode === 'w402-test' ||
      this.executionMode === 'w601-test' ||
      this.executionMode === 'local'
    ) {
      return this.processIsolatedExecution(data);
    }

    if (execution.status === 'COMPLETED' || execution.completedAt) {
      return { status: 'already_completed' };
    }
    if (execution.status === 'CANCELLED') return { status: 'cancelled' };
    if (execution.status === 'PAUSED') return { status: 'paused' };

    this.logger.log(`Campaign execution eligible: ${data.organizationId}/${data.campaignId}`);
    return { status: 'eligible' };
  }

  private async processIsolatedExecution(
    data: CampaignExecutionJobData,
  ): Promise<CampaignExecutionProcessorResult> {
    if (!this.callInitiation) throw new Error('campaign_call_initiation_service_missing');

    const database = this.prisma as unknown as {
      campaignRecipient: {
        findMany(input: unknown): Promise<Array<{ id: string }>>;
      };
    };
    const recipients = await database.campaignRecipient.findMany({
      where: { organizationId: data.organizationId, campaignId: data.campaignId },
      orderBy: { id: 'asc' },
      select: { id: true },
    });
    if (recipients.length === 0) return { status: 'no_recipients' };

    const outcomes: Array<{ recipientId: string; result: InitiationResult }> = [];
    for (const recipient of recipients) {
      const result = await this.callInitiation.initiate({
        organizationId: data.organizationId,
        campaignId: data.campaignId,
        recipientId: recipient.id,
      });
      if (result.status === 'retryable_conflict') {
        throw new Error('campaign_execution_claim_retryable_conflict');
      }
      outcomes.push({ recipientId: recipient.id, result });
    }

    const reconciliationRequired = outcomes.some(({ result }) => result.status === 'uncertain');
    return {
      status: reconciliationRequired ? 'reconciliation_required' : 'processed',
      recipientCount: outcomes.length,
      outcomes,
    };
  }
}