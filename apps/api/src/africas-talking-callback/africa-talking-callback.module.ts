import { Module } from '@nestjs/common';
import { CallbackReceipts, type CallDatabase } from '@truevine/telephony';

import { InfrastructureModule } from '../infrastructure/infrastructure.module.js';
import { DATABASE_CLIENT } from '../tokens.js';
import {
  AfricaTalkingCallbackController,
  callbackApiKeyFromEnv,
} from './africa-talking-callback.controller.js';

/**
 * Africa's Talking callback intake.
 *
 * The route is registered with fail-closed verification: a missing, blank or
 * short `AT_CALLBACK_API_KEY` leaves the controller rejecting every callback.
 * The only side effect is a durable receipt insert; no settlement, dispatch or
 * provider call is wired here.
 */
@Module({
  imports: [InfrastructureModule],
  providers: [
    {
      provide: 'AT_CALLBACK_API_KEY',
      useFactory: () => callbackApiKeyFromEnv(process.env['AT_CALLBACK_API_KEY']),
    },
    {
      provide: CallbackReceipts,
      inject: [DATABASE_CLIENT],
      useFactory: (database: CallDatabase) => new CallbackReceipts(database),
    },
    AfricaTalkingCallbackController,
  ],
  controllers: [AfricaTalkingCallbackController],
  exports: [CallbackReceipts],
})
export class AfricaTalkingCallbackModule {}
