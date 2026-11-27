/**
 * SMS provider port interface.
 *
 * Declared structurally so application services can be unit-tested without a
 * real provider. Implementations are adapter-bound and provider-specific.
 *
 * Phone numbers are E.164. Message content is an opaque string the caller is
 * responsible for; the adapter must not log content or credentials.
 */

export type SmsEnvironment = 'SANDBOX' | 'PRODUCTION';

export interface SmsAdapterConfig {
  readonly environment: SmsEnvironment;
  readonly senderId: string;
}

export interface SmsSendRequest {
  readonly to: string;
  readonly body: string;
  readonly idempotencyKey: string;
  readonly organizationId: string;
  readonly campaignId: string;
  readonly recipientId: string;
}

export interface SmsSendResult {
  readonly providerReference: string;
  readonly accepted: boolean;
  readonly rejected: boolean;
  readonly uncertain: boolean;
}

export type SmsProvider = 'SYNTHETIC' | 'AFRICAS_TALKING' | 'UNKNOWN';

export interface SmsProviderStatus {
  readonly provider: SmsProvider;
  readonly environment: SmsEnvironment;
  readonly configured: boolean;
  readonly enabled: boolean;
  readonly ready: boolean;
  readonly checkedAt: Date | null;
  readonly checkResult: 'verified' | 'rejected' | 'unavailable' | null;
}

/**
 * SMS port: providers implement this contract.
 */
export interface SmsPort {
  readonly provider: SmsProvider;
  readonly environment: SmsEnvironment;

  isReady(): Promise<SmsProviderStatus>;
  send(request: SmsSendRequest): Promise<SmsSendResult>;
}

/**
 * No-op SMS port for when SMS fallback is disabled or not configured.
 * Rejects every dispatch with a clear error so callers never silently
 * assume an SMS was sent.
 */
export class UnavailableSmsPort implements SmsPort {
  readonly provider = 'UNKNOWN';
  readonly environment = 'SANDBOX';

  async isReady(): Promise<SmsProviderStatus> {
    return {
      provider: 'UNKNOWN',
      environment: 'SANDBOX',
      configured: false,
      enabled: false,
      ready: false,
      checkedAt: null,
      checkResult: 'unavailable',
    };
  }

  async send(): Promise<SmsSendResult> {
    throw new Error('sms_provider_unavailable');
  }
}
