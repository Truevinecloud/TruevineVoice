import 'reflect-metadata';

import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { loadEnvFiles } from '@truevine/shared';

import { AppModule } from './app.module.js';
import { loadApiConfig } from './config/api.config.js';

/**
 * API entry point.
 *
 * Boot order matters: environment variables are loaded before any module is
 * instantiated, because configuration is validated eagerly and a missing
 * variable must fail the process instead of surfacing as a confusing runtime
 * error later.
 */
async function bootstrap(): Promise<void> {
  loadEnvFiles();
  const config = loadApiConfig();

  const app = await NestFactory.create(AppModule);

  // Lets Nest run onApplicationShutdown hooks, so Prisma and Redis connections
  // are released on SIGTERM/SIGINT.
  app.enableShutdownHooks();

  await app.listen(config.port, config.host);

  const logger = new Logger(config.serviceName);
  logger.log(
    `listening on http://${config.host}:${config.port} ` +
      `(env=${config.environment}, version=${config.version})`,
  );
  logger.log('health endpoint: GET /health');
}

void bootstrap().catch((error: unknown) => {
  // Nest's static Logger is usable before the DI container exists, so start-up
  // failures are reported through the same structured sink as everything else.
  new Logger('ApiBootstrap').error(
    'failed to start',
    error instanceof Error ? error.stack : String(error),
  );
  process.exit(1);
});
