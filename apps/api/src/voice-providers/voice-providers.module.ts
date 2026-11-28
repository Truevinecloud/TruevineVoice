import { Body, Controller, Get, Header, Inject, Module, Param, Put, UseGuards } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module.js';
import { CsrfGuard } from '../auth/csrf.guard.js';
import { PlatformGuard } from '../auth/organization.guard.js';
import { CurrentPrincipal, RequirePlatformPermission } from '../auth/permission.decorators.js';
import type { Principal } from '../auth/principal.js';
import { SessionGuard } from '../auth/session.guard.js';
import { InfrastructureModule } from '../infrastructure/infrastructure.module.js';
import { environmentOf, VOICE_FETCH, VOICE_KEY, voiceKeyFromEnv, VoiceProvidersService } from './voice-providers.service.js';

@Controller('platform/voice-providers')
export class VoiceProvidersController {
  constructor(@Inject(VoiceProvidersService) private readonly service: VoiceProvidersService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  @UseGuards(SessionGuard, PlatformGuard)
  @RequirePlatformPermission('platform:technical:write')
  list() {
    return this.service.list();
  }

  @Put(':environment')
  @Header('Cache-Control', 'no-store')
  @UseGuards(SessionGuard, PlatformGuard, CsrfGuard)
  @RequirePlatformPermission('platform:technical:write')
  save(@CurrentPrincipal() actor: Principal, @Param('environment') environment: string, @Body() body: unknown) {
    return this.service.save(actor.userId, environmentOf(environment), body);
  }

  @Put(':environment/connection')
  @Header('Cache-Control', 'no-store')
  @UseGuards(SessionGuard, PlatformGuard, CsrfGuard)
  @RequirePlatformPermission('platform:technical:write')
  check(@CurrentPrincipal() actor: Principal, @Param('environment') environment: string) {
    return this.service.testConnection(actor.userId, environmentOf(environment));
  }

  @Put(':environment/activation')
  @Header('Cache-Control', 'no-store')
  @UseGuards(SessionGuard, PlatformGuard, CsrfGuard)
  @RequirePlatformPermission('platform:technical:write')
  activate(@CurrentPrincipal() actor: Principal, @Param('environment') environment: string, @Body() body: unknown) {
    return this.service.activate(actor.userId, environmentOf(environment), body);
  }
}

@Module({
  imports: [AuthModule, InfrastructureModule],
  controllers: [VoiceProvidersController],
  providers: [
    VoiceProvidersService,
    { provide: VOICE_KEY, useFactory: () => voiceKeyFromEnv(process.env['VOICE_CREDENTIAL_ENCRYPTION_KEY']) },
    { provide: VOICE_FETCH, useValue: globalThis.fetch },
  ],
  exports: [VoiceProvidersService],
})
export class VoiceProvidersModule {}
