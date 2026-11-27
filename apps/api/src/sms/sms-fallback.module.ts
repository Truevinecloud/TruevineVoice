import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module.js';
import { SMS_PORT } from './sms-tokens.js';
import { UnavailableSmsPort } from './sms-port.js';
import { SyntheticSmsAdapter } from './synthetic-sms-adapter.js';
import { SmsFallbackEligibilityService } from './sms-fallback-eligibility.service.js';
import { SmsFallbackOrchestrationService } from './sms-fallback-orchestration.service.js';
import { SmsFallbackController } from './sms-fallback.controller.js';

class DisabledSmsPort extends UnavailableSmsPort {}

/**
 * SMS fallback module.
 *
 * SMS fallback is disabled by default. The SMS provider port is an
 * `UnavailableSmsPort` unless explicitly configured with a real or synthetic
 * adapter. No SMS is sent unless the module is explicitly enabled.
 */
@Module({
  imports: [AuthModule],
  providers: [
    {
      provide: SMS_PORT,
      useFactory: () => {
        if (process.env['W504_SMS_FALLBACK_ENABLED'] === 'true') {
          return new SyntheticSmsAdapter({
            environment: 'SANDBOX',
            senderId: 'TRUEVINE',
            results: new Map(),
          });
        }
        return new DisabledSmsPort();
      },
    },
    SmsFallbackEligibilityService,
    SmsFallbackOrchestrationService,
    SmsFallbackController,
  ],
  exports: [SMS_PORT, SmsFallbackEligibilityService, SmsFallbackOrchestrationService],
})
export class SmsFallbackModule {}
