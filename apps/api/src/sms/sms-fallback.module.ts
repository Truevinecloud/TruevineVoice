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
 * Resolves the API SMS port at start-up. The synthetic adapter is local-only
 * and never selected in production, including when the opt-in flag is
 * mistakenly present. Every other state rejects dispatch.
 */
export function smsPortFromEnvironment(env: NodeJS.ProcessEnv = process.env) {
  const enabled = env['W504_SMS_FALLBACK_ENABLED'] === 'true';
  const production = (env['NODE_ENV'] ?? 'development').trim() === 'production';
  if (!enabled || production) return new DisabledSmsPort();
  return new SyntheticSmsAdapter({
    environment: 'SANDBOX',
    senderId: 'TRUEVINE',
    results: new Map(),
  });
}

/**
 * SMS fallback module.
 *
 * SMS fallback is disabled by default. The SMS provider port is an
 * `UnavailableSmsPort` unless explicitly configured with a local synthetic
 * adapter outside production. No SMS is sent unless the module is explicitly
 * enabled, and no external SMS client is registered here.
 */
@Module({
  imports: [AuthModule],
  providers: [
    {
      provide: SMS_PORT,
      useFactory: () => smsPortFromEnvironment(),
    },
    SmsFallbackEligibilityService,
    SmsFallbackOrchestrationService,
    SmsFallbackController,
  ],
  exports: [SMS_PORT, SmsFallbackEligibilityService, SmsFallbackOrchestrationService],
})
export class SmsFallbackModule {}
