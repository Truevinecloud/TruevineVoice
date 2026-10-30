/**
 * Provider-specific credential contracts.
 *
 * MTN Mobile Money and Airtel Money do not share a credential shape, so the
 * platform stores and validates them separately. This module is deliberately
 * about *configuration* only: it says which fields a provider needs and how each
 * is bounded. It contains no HTTP client, no token exchange and no payment call.
 *
 * The field names below are the values accepted by the API. A provider's own
 * header names (`Ocp-Apim-Subscription-Key`, `client_secret`, ...) are an
 * adapter concern and must not leak into the platform's stored vocabulary.
 */

export const PAYMENT_PROVIDERS = ['MTN_MOMO', 'AIRTEL_MONEY'] as const;
export type PaymentProvider = (typeof PAYMENT_PROVIDERS)[number];

export const PAYMENT_ENVIRONMENTS = ['SANDBOX', 'PRODUCTION'] as const;
export type PaymentProviderEnvironment = (typeof PAYMENT_ENVIRONMENTS)[number];

export interface CredentialFieldContract {
  readonly name: string;
  readonly label: string;
  /** Secret fields are rendered as password inputs and never returned. */
  readonly secret: boolean;
  readonly required: boolean;
  readonly maxLength: number;
  readonly help: string;
}

export interface PaymentProviderContract {
  readonly provider: PaymentProvider;
  readonly displayName: string;
  readonly detail: string;
  readonly credentialFields: readonly CredentialFieldContract[];
}

const MTN_CONTRACT: PaymentProviderContract = Object.freeze({
  provider: 'MTN_MOMO',
  displayName: 'MTN Mobile Money',
  detail:
    'MTN MoMo Collections credentials. Sandbox and production credentials are issued separately by MTN.',
  credentialFields: Object.freeze([
    Object.freeze({
      name: 'subscriptionKey',
      label: 'Subscription key',
      secret: true,
      required: true,
      maxLength: 256,
      help: 'The Collections product subscription key (Ocp-Apim-Subscription-Key).',
    }),
    Object.freeze({
      name: 'apiUser',
      label: 'API user',
      secret: true,
      required: true,
      maxLength: 128,
      help: 'The API user reference issued for this environment.',
    }),
    Object.freeze({
      name: 'apiKey',
      label: 'API key',
      secret: true,
      required: true,
      maxLength: 256,
      help: 'The API key paired with the API user. Used only to obtain an access token.',
    }),
  ]),
});

const AIRTEL_CONTRACT: PaymentProviderContract = Object.freeze({
  provider: 'AIRTEL_MONEY',
  displayName: 'Airtel Money',
  detail:
    'Airtel Money OAuth 2.0 client credentials. The sandbox and production portals issue independent clients.',
  credentialFields: Object.freeze([
    Object.freeze({
      name: 'clientId',
      label: 'Client ID',
      secret: true,
      required: true,
      maxLength: 256,
      help: 'The OAuth 2.0 client identifier from the Airtel developer portal.',
    }),
    Object.freeze({
      name: 'clientSecret',
      label: 'Client secret',
      secret: true,
      required: true,
      maxLength: 512,
      help: 'The OAuth 2.0 client secret. Used only to obtain an access token.',
    }),
  ]),
});

export const PAYMENT_PROVIDER_CONTRACTS: Readonly<
  Record<PaymentProvider, PaymentProviderContract>
> = Object.freeze({
  MTN_MOMO: MTN_CONTRACT,
  AIRTEL_MONEY: AIRTEL_CONTRACT,
});

export function isPaymentProvider(value: unknown): value is PaymentProvider {
  return typeof value === 'string' && (PAYMENT_PROVIDERS as readonly string[]).includes(value);
}

export function isPaymentEnvironment(value: unknown): value is PaymentProviderEnvironment {
  return typeof value === 'string' && (PAYMENT_ENVIRONMENTS as readonly string[]).includes(value);
}

export function environmentLabel(environment: PaymentProviderEnvironment): string {
  return environment === 'SANDBOX' ? 'Sandbox' : 'Production';
}
