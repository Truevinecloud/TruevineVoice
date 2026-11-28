/**
 * Africa's Talking voice callback webhook — fail-closed durable receipt intake.
 *
 * Africa's Talking does not document a signed callback, so the only
 * implemented check is a shared API key. An absent, blank or short key leaves
 * every request rejected: there is no unauthenticated public callback path.
 *
 * The handler only records durable receipts. It places no calls, charges
 * nothing and does not mutate provider state. Correlation and state changes
 * belong to the callback worker, using the binding created during dispatch.
 * Provider field names are normalized inside @truevine/telephony and do not
 * enter our domain types.
 */

import { timingSafeEqual } from 'node:crypto';

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

/**
 * Resolves the optional shared callback key at start-up. A short or blank
 * value is treated as absent so a misconfigured ingress rejects everything
 * instead of accepting a guessable key.
 */
export function callbackApiKeyFromEnv(value: string | undefined): string | null {
  const candidate = value?.trim();
  return candidate && candidate.length >= 32 ? candidate : null;
}

/** Constant-time comparison with a length guard; no key material is logged. */
function apiKeyMatches(provided: string, expected: string): boolean {
  const supplied = Buffer.from(provided, 'utf8');
  const configured = Buffer.from(expected, 'utf8');
  return supplied.length === configured.length && timingSafeEqual(supplied, configured);
}

/** Africa's Talking outbound call event webhook: authenticated receipt intake only. */
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
    if (!providedKey || !apiKeyMatches(providedKey, this.expectedApiKey))
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
