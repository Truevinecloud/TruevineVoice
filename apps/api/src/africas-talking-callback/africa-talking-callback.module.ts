import { Global, Inject, Module } from '@nestjs/common';
import { CallbackReceipts, type CallDatabase } from '@truevine/telephony';

import { DATABASE_CLIENT } from '../tokens.js';
import { AfricaTalkingCallbackController } from './africa-talking-callback.controller.js';

/**
 * Africa's Talking voice callback webhook module.
 *
 * Registers the `/webhooks/africastalking` POST endpoint that receives call
 * event callbacks from Africa's Talking and records them as durable receipts.
 *
 * To enable, add this module to `AppModule.imports` and configure the
 * `AT_CALLBACK_API_KEY` provider (see `AT_CALLBACK_API_KEY` token below).
 */
@Global()
@Module({
  providers: [
    {
      provide: 'AT_CALLBACK_API_KEY',
      useFactory: () => process.env['AT_CALLBACK_API_KEY'] ?? null,
    },
    {
      provide: CallbackReceipts,
      inject: [DATABASE_CLIENT],
      useFactory: (database: CallDatabase) => new CallbackReceipts(database),
    },
    AfricaTalkingCallbackController,
  ],
  controllers: [AfricaTalkingCallbackController],
  exports: [AfricaTalkingCallbackController],
})
export class AfricaTalkingCallbackModule {
  constructor(@Inject(DATABASE_CLIENT) readonly _db: unknown) {}
}
