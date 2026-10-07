import { Global, Module } from '@nestjs/common';

import { loadApiConfig, type ApiConfig } from './api.config.js';

export const APP_CONFIG = Symbol('APP_CONFIG');

/**
 * Provides the validated {@link ApiConfig} to the whole application.
 *
 * Global because configuration is cross-cutting and must be identical
 * everywhere; it is read-only and created exactly once.
 */
@Global()
@Module({
  providers: [
    {
      provide: APP_CONFIG,
      useFactory: (): ApiConfig => loadApiConfig(),
    },
  ],
  exports: [APP_CONFIG],
})
export class AppConfigModule {}
