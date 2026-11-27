import { Module, type OnModuleDestroy } from '@nestjs/common';
import { PollyTextToSpeechProvider, S3AudioStorage } from '@truevine/audio';

import type { PrismaClient } from '@truevine/database';

import { AuthModule } from '../auth/auth.module.js';
import { APP_CONFIG } from '../config/app-config.module.js';
import type { ApiConfig } from '../config/api.config.js';
import { InfrastructureModule } from '../infrastructure/infrastructure.module.js';
import { DATABASE_CLIENT } from '../tokens.js';
import { AudioController } from './audio.controller.js';
import { AudioService } from './audio.service.js';
import { PrismaAudioStore } from './prisma-audio.store.js';
import { PostgresqlAudioStorage } from './storage/postgresql-audio.storage.js';
import { StorageRouter } from './storage/storage-router.js';
import { AudioQuotaGuard } from './quota/quota-guard.js';
import { AUDIO_OBJECT_STORE, AUDIO_STORE, AUDIO_TTS_PROVIDER } from './audio.tokens.js';

class AudioAdaptersLifecycle implements OnModuleDestroy {
  constructor(
    private readonly storage: S3AudioStorage | null,
    private readonly postgresqlStorage: PostgresqlAudioStorage | null,
    private readonly tts: PollyTextToSpeechProvider | null,
  ) {}
  async onModuleDestroy(): Promise<void> {
    await Promise.all([
      this.storage?.close(),
      this.postgresqlStorage?.close?.(),
      this.tts?.close?.(),
    ]);
  }
}

@Module({
  imports: [AuthModule, InfrastructureModule],
  controllers: [AudioController],
  providers: [
    AudioService,
    PrismaAudioStore,
    PostgresqlAudioStorage,
    AudioQuotaGuard,
    StorageRouter,
    { provide: AUDIO_STORE, useExisting: PrismaAudioStore },
    {
      provide: AUDIO_OBJECT_STORE,
      inject: [StorageRouter],
      useFactory: (router: StorageRouter) => (router.isAvailable() ? router : null),
    },
    {
      provide: AUDIO_TTS_PROVIDER,
      inject: [APP_CONFIG],
      useFactory: (config: ApiConfig) =>
        config.audioTtsRegion ? new PollyTextToSpeechProvider(config.audioTtsRegion) : null,
    },
    {
      provide: S3AudioStorage,
      inject: [APP_CONFIG],
      useFactory: (config: ApiConfig) =>
        config.audioStorage ? new S3AudioStorage(config.audioStorage) : null,
    },
    {
      provide: StorageRouter,
      inject: [PostgresqlAudioStorage, S3AudioStorage, DATABASE_CLIENT],
      useFactory: (
        postgresql: PostgresqlAudioStorage,
        s3: S3AudioStorage | null,
        prisma: PrismaClient,
      ) => new StorageRouter(postgresql, s3, prisma),
    },
    {
      provide: AudioAdaptersLifecycle,
      inject: [S3AudioStorage, PostgresqlAudioStorage, AUDIO_TTS_PROVIDER],
      useFactory: (
        storage: S3AudioStorage | null,
        postgresqlStorage: PostgresqlAudioStorage | null,
        tts: PollyTextToSpeechProvider | null,
      ) =>
        new AudioAdaptersLifecycle(storage, postgresqlStorage, tts),
    },
  ],
  exports: [AudioService],
})
export class AudioModule {}
