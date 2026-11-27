import {
  BadRequestException,
  Controller,
  HttpCode,
  Inject,
  InternalServerErrorException,
  NotFoundException,
  PayloadTooLargeException,
  Post,
  Req,
  UnsupportedMediaTypeException,
  UnauthorizedException,
} from '@nestjs/common';

import { LocalCallbackService } from './local-callback.service.js';
import { hasJsonContentType, LOCAL_CALLBACK_KEY_HEADER } from './local-callback.shared.js';

interface LocalCallbackHttpRequest {
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly socket?: { readonly remoteAddress?: string | null };
  readonly body?: unknown;
}

/** Local-only test ingress. It has no provider adapter and no dispatch path. */
@Controller('local/callbacks')
export class LocalCallbackController {
  constructor(@Inject(LocalCallbackService) private readonly service: LocalCallbackService) {}

  @Post('synthetic')
  @HttpCode(202)
  async synthetic(@Req() request: LocalCallbackHttpRequest) {
    if (!this.service.isEnabled() || !this.service.isLoopback(request.socket?.remoteAddress))
      throw new NotFoundException('Not found.');

    if (!hasJsonContentType(request.headers['content-type']))
      throw new UnsupportedMediaTypeException('Unsupported content type.');

    if (!this.service.verifyCredential(request.headers[LOCAL_CALLBACK_KEY_HEADER]))
      throw new UnauthorizedException('Invalid request.');

    const parsed = this.service.parseBody(request.body);
    if (!parsed.ok) {
      if (parsed.status === 413) throw new PayloadTooLargeException('Payload too large.');
      throw new BadRequestException('Invalid request body.');
    }

    const result = await this.service.ingest(parsed.event);
    if (!result.ok) {
      if (result.status === 400) throw new BadRequestException('Invalid request body.');
      throw new InternalServerErrorException('Callback could not be accepted.');
    }
    return result.response.body;
  }
}
