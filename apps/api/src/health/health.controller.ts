import { Controller, Get, HttpException, HttpStatus, Inject } from '@nestjs/common';
import type { HealthReport } from '@truevine/shared';

import { HealthService } from './health.service.js';

/**
 * Infrastructure health endpoint.
 *
 * Contains no database queries: the controller only maps a {@link HealthReport}
 * onto an HTTP status code, which keeps business and persistence concerns out of
 * the transport layer.
 */
@Controller('health')
export class HealthController {
  // Explicit token: constructor injection never relies on
  // `emitDecoratorMetadata`, which keeps the test toolchain free of native
  // transformers. See apps/api/vitest.config.mts.
  constructor(@Inject(HealthService) private readonly healthService: HealthService) {}

  /**
   * `200` when every probed dependency is reachable, `503` otherwise.
   *
   * The report body is identical in both cases so that orchestrators and humans
   * can read the same payload.
   */
  @Get()
  async getHealth(): Promise<HealthReport> {
    const report = await this.healthService.check();

    if (report.status !== 'ok') {
      throw new HttpException(report, HttpStatus.SERVICE_UNAVAILABLE);
    }

    return report;
  }
}
