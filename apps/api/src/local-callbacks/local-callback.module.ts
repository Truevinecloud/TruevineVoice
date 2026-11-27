import { Module } from '@nestjs/common';
import { CallbackReceipts, type CallDatabase } from '@truevine/telephony';

import { DATABASE_CLIENT } from '../tokens.js';
import { LocalCallbackController } from './local-callback.controller.js';
import { LocalCallbackService, LOCAL_CALLBACK_RECEIPTS } from './local-callback.service.js';

/** Wires the loopback-only synthetic callback ingress to the durable receipt boundary. */
@Module({
  controllers: [LocalCallbackController],
  providers: [
    LocalCallbackService,
    {
      provide: LOCAL_CALLBACK_RECEIPTS,
      inject: [DATABASE_CLIENT],
      useFactory: (database: CallDatabase) => new CallbackReceipts(database),
    },
  ],
})
export class LocalCallbackModule {}
