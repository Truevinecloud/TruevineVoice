import 'reflect-metadata';

import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { loadEnvFiles } from '@truevine/shared';

import { AppModule } from './app.module.js';
import { loadWorkerConfig } from './config/worker.config.js';

/**
 * Worker entry point.
 *
 * Runs as an application context (no HTTP server). Redis connectivity and the
 * BullMQ connection options are established at boot; no business queues or
 * processors are registered yet.
 */
async function bootstrap(): Promise<void> {
  loadEnvFiles();
  const config = loadWorkerConfig();

  const logger = new Logger('WorkerBootstrap');
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn', 'log'],
  });

  app.enableShutdownHooks();

  logger.log(
    `${config.serviceName} started (env=${config.environment}, version=${config.version})`,
  );
  logger.log(
    'no business queues registered yet - background processing arrives with its first feature',
  );
}

void bootstrap().catch((error: unknown) => {
  // Nest's static Logger is usable before the DI container exists, so start-up
  // failures are reported through the same structured sink as everything else.
  new Logger('WorkerBootstrap').error(
    'failed to start',
    error instanceof Error ? error.stack : String(error),
  );
  process.exit(1);
});
