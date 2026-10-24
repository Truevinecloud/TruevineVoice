import {
  Body,
  Controller,
  Get,
  Headers,
  Inject,
  Param,
  Post,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { invalidAudio } from '@truevine/auth';

import { CsrfGuard } from '../auth/csrf.guard.js';
import { OrganizationGuard } from '../auth/organization.guard.js';
import {
  CurrentOrganization,
  CurrentPrincipal,
  RequireAcceptedTerms,
  RequireOrganizationPermission,
} from '../auth/permission.decorators.js';
import { SessionGuard } from '../auth/session.guard.js';
import { AudioService } from './audio.service.js';

const Protected = [SessionGuard, OrganizationGuard, CsrfGuard];

@Controller('organizations/:organizationId/audio-assets')
export class AudioController {
  constructor(@Inject(AudioService) private readonly audio: AudioService) {}

  @Get()
  @UseGuards(...Protected)
  @RequireAcceptedTerms()
  @RequireOrganizationPermission('audio:read')
  list(@CurrentOrganization() org: { organizationId: string }) {
    return this.audio.list(org.organizationId);
  }

  @Get('voices')
  @UseGuards(...Protected)
  @RequireAcceptedTerms()
  @RequireOrganizationPermission('audio:read')
  voices() {
    return this.audio.voices();
  }

  @Post('recordings')
  @UseGuards(...Protected)
  @RequireAcceptedTerms()
  @RequireOrganizationPermission('audio:create')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 10 * 1024 * 1024, files: 1 } }))
  recording(
    @CurrentOrganization() org: { organizationId: string },
    @CurrentPrincipal() principal: { userId: string },
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @UploadedFile() file: { originalname: string; mimetype: string; buffer: Buffer } | undefined,
    @Body('name') name: unknown,
  ) {
    if (!file) throw invalidAudio('Choose an audio recording to upload.');
    return this.audio.record({
      organizationId: org.organizationId,
      actorUserId: principal.userId,
      idempotencyKey,
      name: name ?? file.originalname,
      declaredMimeType: file.mimetype,
      bytes: file.buffer,
    });
  }

  @Post('tts')
  @UseGuards(...Protected)
  @RequireAcceptedTerms()
  @RequireOrganizationPermission('audio:create')
  synthesize(
    @CurrentOrganization() org: { organizationId: string },
    @CurrentPrincipal() principal: { userId: string },
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: { readonly name?: unknown; readonly text?: unknown; readonly voice?: unknown },
  ) {
    return this.audio.synthesize({
      organizationId: org.organizationId,
      actorUserId: principal.userId,
      idempotencyKey,
      name: body.name,
      text: body.text,
      voice: body.voice,
    });
  }

  @Post(':assetId/playback-link')
  @UseGuards(...Protected)
  @RequireAcceptedTerms()
  @RequireOrganizationPermission('audio:read')
  playback(
    @CurrentOrganization() org: { organizationId: string },
    @CurrentPrincipal() principal: { userId: string },
    @Param('assetId') assetId: string,
  ) {
    return this.audio.playbackLink(org.organizationId, principal.userId, assetId);
  }
}
