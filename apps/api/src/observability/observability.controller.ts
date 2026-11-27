/**
 * Observability controller for the API.
 *
 * Exposes `GET /metrics` returning the current observability state:
 * queue depth, host resources, active alerts, and collection timestamps.
 *
 * Read-only: no mutation of queue, payment, or provider state.
 * No sensitive data is exposed: alert values are metric numbers only.
 */

import {
  Controller,
  Get,
  Inject,
  UseGuards,
} from '@nestjs/common';

import { SessionGuard } from '../auth/session.guard.js';
import { PlatformGuard } from '../auth/organization.guard.js';
import { RequirePlatformPermission } from '../auth/permission.decorators.js';
import { ObservabilityService } from './observability.service.js';

/**
 * Observability metrics endpoint.
 *
 * Returns a snapshot of the current observability state, including metric
 * samples, alert evaluations, firing/recovering alerts, and overall severity.
 *
 * Requires an authenticated session with platform `platform:operations:read`
 * permission, matching the operations controller authorization boundary.
 */
@Controller('metrics')
@UseGuards(SessionGuard, PlatformGuard)
@RequirePlatformPermission('platform:operations:read')
export class ObservabilityController {
  constructor(@Inject(ObservabilityService) private readonly observability: ObservabilityService) {}

  /**
   * Returns the current observability state.
   *
   * Always returns 200: observability is best-effort and never causes the
   * API to report unhealthy.
   */
  @Get()
  getMetrics() {
    return this.observability.state;
  }
}
