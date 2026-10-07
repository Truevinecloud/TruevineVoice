import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { probeRedis, type PingableClient } from '@truevine/queue';
import { overallStatusFrom, type DependencyHealth } from '@truevine/shared';

import { WORKER_CONFIG } from '../config/worker-config.module.js';
import type { WorkerConfig } from '../config/worker.config.js';
import { REDIS_CLIENT } from '../tokens.js';

/**
 * Startup readiness for the worker.
 *
 * The worker runs as an application context with no HTTP surface, so
 * Redis reachability is verified once at boot and reported through the log. A
 * failure is logged loudly but does not abort start-up: the worker is expected
 * to keep retrying while Redis restarts, and killing the process would only move
 * the failure to the supervisor.
 */
@Injectable()
export class WorkerReadinessService implements OnApplicationBootstrap {
  private readonly logger = new Logger(WorkerReadinessService.name);
  private lastStatus: 'ok' | 'degraded' = 'degraded';

  constructor(
    @Inject(WORKER_CONFIG) private readonly config: WorkerConfig,
    @Inject(REDIS_CLIENT) private readonly redis: PingableClient,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const report = await this.check();
    this.logger.log(
      `redis reachable=${report.dependencies.redis?.status} latencyMs=${report.dependencies.redis?.latencyMs}`,
    );
  }

  /** Current readiness, derived from the last probe. */
  get status(): 'ok' | 'degraded' {
    return this.lastStatus;
  }

  /** Probes Redis and returns a health-shaped report. */
  async check(): Promise<{
    status: 'ok' | 'degraded';
    dependencies: Readonly<Record<string, DependencyHealth>>;
  }> {
    const redis = await probeRedis(this.redis, this.config.healthTimeoutMs);
    const dependencies: Readonly<Record<string, DependencyHealth>> = { redis };
    this.lastStatus = overallStatusFrom(dependencies);
    return { status: this.lastStatus, dependencies };
  }
}
