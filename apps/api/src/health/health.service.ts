import { Inject, Injectable } from '@nestjs/common';
import { probeDatabase, type QueryableClient } from '@truevine/database';
import { probeRedis, type PingableClient } from '@truevine/queue';
import { overallStatusFrom, type DependencyHealth, type HealthReport } from '@truevine/shared';

import { APP_CONFIG } from '../config/app-config.module.js';
import type { ApiConfig } from '../config/api.config.js';
import { DATABASE_CLIENT, REDIS_CLIENT } from '../tokens.js';

/**
 * Produces the structured health report served by `GET /health`.
 *
 * The controller owns HTTP concerns only; every probe decision lives here.
 */
@Injectable()
export class HealthService {
  private readonly startedAt = Date.now();

  constructor(
    @Inject(APP_CONFIG) private readonly config: ApiConfig,
    @Inject(DATABASE_CLIENT) private readonly database: QueryableClient,
    @Inject(REDIS_CLIENT) private readonly redis: PingableClient,
  ) {}

  /** Probes every declared dependency and returns a health report. */
  async check(): Promise<HealthReport> {
    const timeoutMs = this.config.healthTimeoutMs;

    const [postgres, redis]: [DependencyHealth, DependencyHealth] = await Promise.all([
      probeDatabase(this.database, timeoutMs),
      probeRedis(this.redis, timeoutMs),
    ]);

    const dependencies: Readonly<Record<string, DependencyHealth>> = { postgres, redis };

    return {
      status: overallStatusFrom(dependencies),
      service: this.config.serviceName,
      version: this.config.version,
      environment: this.config.environment,
      uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1_000),
      timestamp: new Date().toISOString(),
      dependencies,
    };
  }
}
