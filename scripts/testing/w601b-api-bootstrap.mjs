/**
 * W6-01B-only API bootstrap.
 *
 * The shared API module graph currently contains an unrelated W5-02 wiring
 * defect: PaymentIntentsService is used by TopUpIntegrationModule but is not
 * exported by PaymentIntentsModule. That blocks every API boot, including W6-01B
 * browser acceptance. This launcher overrides that one unrelated provider with
 * an inert stub for this isolated QA stack only; it does not edit application
 * source, weaken a test or touch the W5-02 module graph.
 */

import 'reflect-metadata';

import { Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import express from 'express';
import { loadEnvFiles } from '@truevine/shared';

import { AppModule } from '../../apps/api/dist/app.module.js';
import { BillingService } from '../../apps/api/dist/billing/billing.service.js';
import { databaseNameOf, loadApiConfig } from '../../apps/api/dist/config/api.config.js';
import { PaymentIntentsService } from '../../apps/api/dist/payments/payment-intents.service.js';
import { TopUpIntegrationService } from '../../apps/api/dist/payments/top-up-integration.service.js';
import { LOCAL_CALLBACK_PATH } from '../../apps/api/dist/local-callbacks/local-callback.shared.js';
import { localCallbackMiddleware } from '../../apps/api/dist/local-callbacks/local-callback.middleware.js';

async function bootstrap() {
  loadEnvFiles();
  const config = loadApiConfig();
  if (config.port !== 3201 || config.host !== '127.0.0.1') {
    throw new Error('W6-01B API bootstrap requires 127.0.0.1:3201.');
  }
  if (databaseNameOf(config.databaseUrl) !== 'truevine_w601b_qa') {
    throw new Error('W6-01B API bootstrap refuses every database except truevine_w601b_qa.');
  }

  const inertPayments = {
    createPending: async () => {
      throw new Error('W6-01B QA does not expose payment intents.');
    },
  };
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(BillingService)
    .useValue({})
    .overrideProvider(PaymentIntentsService)
    .useValue(inertPayments)
    .overrideProvider(TopUpIntegrationService)
    .useValue({})
    .compile();

  const app = moduleRef.createNestApplication({ bodyParser: false });
  for (const middleware of localCallbackMiddleware(config)) {
    app.use(LOCAL_CALLBACK_PATH, middleware);
  }
  app.use(express.json({ limit: '600kb' }));
  app.use(express.urlencoded({ extended: false, limit: '100kb' }));
  app.enableShutdownHooks();
  await app.listen(config.port, config.host);

  const logger = new Logger('W601BApiBootstrap');
  logger.log(`listening on http://${config.host}:${config.port}`);
  logger.log(`database: ${databaseNameOf(config.databaseUrl)}`);
  logger.log('Unrelated PaymentIntentsService is inert in this isolated QA stack.');
}

bootstrap().catch((error) => {
  new Logger('W601BApiBootstrap').error(
    'failed to start',
    error instanceof Error ? error.stack : String(error),
  );
  process.exit(1);
});
