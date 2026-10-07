import { Module } from '@nestjs/common';

import { HealthController } from './health.controller.js';
import { HealthService } from './health.service.js';

/**
 * Health module.
 *
 * This is the only feature module that exists at the foundation stage. Product
 * modules (contacts, campaigns, voice, wallet, billing, ...) are added later.
 */
@Module({
  controllers: [HealthController],
  providers: [HealthService],
})
export class HealthModule {}
