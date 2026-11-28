/**
 * Africa's Talking voice callback webhook — NOT MOUNTED.
 *
 * This controller is kept on disk for the reviewed callback design but is
 * deliberately absent from `AppModule`. Public/provider callback ingress is
 * not approved: `docs/w4-03-provider-callback-controls.md` still lists the
 * bearer-token, allowlist, retention and test-number decisions as outstanding.
 *
 * If it is ever mounted, it must fail closed. Africa's Talking does not
 * document a signed callback, so the only implemented check is a shared API
 * key. With no key configured, every request is rejected — there is no
 * unauthenticated public callback path.
 *
 * The handler only records durable receipts. It places no calls and does not
 * mutate provider state. Correlation and state changes belong to the callback
 * worker, using the binding created during dispatch. Provider field names are
 * normalized inside @truevine/telephony and do not enter our domain types.
 */

import {
  BadRequestException,
  Controller,
  HttpCode,
  Inject,
  Post,
  Req,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import {
  CallbackNormalizationError,
  CallbackReceipts,
  normalizeAfricaTalkingCallback,
  type NormalizedAfricaTalkingCallback,
} from '@truevine/telephony';

interface AfricaTalkingCallbackRequest {
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly body?: unknown;
}

/** Africa's Talking outbound call event webhook. Kept unwired until approval. */
@Controller('webhooks/africastalking')
export class AfricaTalkingCallbackController {
  constructor(
    @Inject(CallbackReceipts) private readonly receipts: CallbackReceipts,
    @Inject('AT_CALLBACK_API_KEY') private readonly expectedApiKey: string | null,
  ) {}

  @Post()
  @HttpCode(202)
  async receive(@Req() request: AfricaTalkingCallbackRequest): Promise<{ received: boolean }> {
    // Fail closed: no approved authentication contract means no ingress at all.
    if (!this.expectedApiKey)
      throw new ServiceUnavailableException('Africa\u2019s Talking callback ingress is not configured.');

    const header = request.headers['apikey'];
    const providedKey = Array.isArray(header) ? header[0] : header;
    if (!providedKey || providedKey !== this.expectedApiKey)
      throw new UnauthorizedException('Invalid Africa\u2019s Talking callback credentials.');

    let event: NormalizedAfricaTalkingCallback;
    try {
      event = normalizeAfricaTalkingCallback(request.body);
    } catch (error) {
      if (error instanceof CallbackNormalizationError)
        throw new BadRequestException(`Invalid callback payload (${error.code}).`);
      throw error;
    }

    await this.receipts.receive(event);
    return { received: true };
  }
}
