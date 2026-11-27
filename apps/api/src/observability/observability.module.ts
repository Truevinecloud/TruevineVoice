/**
 * Observability module for the API.
 *
 * Provides the observability service and metrics controller.
 */

import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module.js';
import { ObservabilityController } from './observability.controller.js';
import { ObservabilityService } from './observability.service.js';

@Module({
  imports: [AuthModule],
  providers: [ObservabilityService],
  controllers: [ObservabilityController],
  exports: [ObservabilityService],
})
export class ObservabilityModule {}
