import { Module, type OnModuleDestroy } from '@nestjs/common';
import { PollyTextToSpeechProvider, S3AudioStorage } from '@truevine/audio';

import { AuthModule } from '../auth/auth.module.js';
import { APP_CONFIG } from '../config/app-config.module.js';
import type { ApiConfig } from '../config/api.config.js';
import { InfrastructureModule } from '../infrastructure/infrastructure.module.js';
import { AudioController } from './audio.controller.js';
import { AudioService } from './audio.service.js';
import { PrismaAudioStore } from './prisma-audio.store.js';
import { AUDIO_OBJECT_STORE, AUDIO_STORE, AUDIO_TTS_PROVIDER } from './audio.tokens.js';

class AudioAdaptersLifecycle implements OnModuleDestroy {
  constructor(
    private readonly storage: S3AudioStorage | null,
    private readonly tts: PollyTextToSpeechProvider | null,
  ) {}
  async onModuleDestroy(): Promise<void> {
    await Promise.all([this.storage?.close(), this.tts?.close()]);
  }
}

@Module({
  imports: [AuthModule, InfrastructureModule],
  controllers: [AudioController],
  providers: [
    AudioService,
    PrismaAudioStore,
    { provide: AUDIO_STORE, useExisting: PrismaAudioStore },
    {
      provide: AUDIO_OBJECT_STORE,
      inject: [APP_CONFIG],
      useFactory: (config: ApiConfig) =>
        config.audioStorage ? new S3AudioStorage(config.audioStorage) : null,
    },
    {
      provide: AUDIO_TTS_PROVIDER,
      inject: [APP_CONFIG],
      useFactory: (config: ApiConfig) =>
        config.audioTtsRegion ? new PollyTextToSpeechProvider(config.audioTtsRegion) : null,
    },
    {
      provide: AudioAdaptersLifecycle,
      inject: [AUDIO_OBJECT_STORE, AUDIO_TTS_PROVIDER],
      useFactory: (storage: S3AudioStorage | null, tts: PollyTextToSpeechProvider | null) =>
        new AudioAdaptersLifecycle(storage, tts),
    },
  ],
  exports: [AudioService],
})
export class AudioModule {}
