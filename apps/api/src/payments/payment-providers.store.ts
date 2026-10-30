/**
 * Persistence contract for payment-provider configuration.
 *
 * The interface carries ciphertext, never a plaintext credential. Encryption
 * and validation happen in the service, so a different store cannot accidentally
 * persist a clear-text value by implementing this contract.
 *
 * Mutations take the audit event they must write. The Prisma implementation
 * writes the configuration row and the identity audit row in one transaction:
 * a saved credential set without its audit event is not an acceptable outcome.
 */

import type { PaymentProvider, PaymentProviderEnvironment } from './payment-provider.contracts.js';

export interface PaymentProviderConfigurationRecord {
  readonly id: string;
  readonly provider: PaymentProvider;
  readonly environment: PaymentProviderEnvironment;
  /** AES-256-GCM envelope, including nonce, tag and ciphertext. */
  readonly credentialsCiphertext: string | null;
  /** Credential field names only; never a value. */
  readonly credentialFields: readonly string[];
  readonly callbackUrl: string | null;
  readonly active: boolean;
  readonly configuredAt: Date | null;
  readonly activatedAt: Date | null;
  readonly deactivatedAt: Date | null;
  readonly version: number;
  readonly updatedAt: Date;
  readonly updatedByUserId: string;
  readonly updatedByEmail: string;
}

export type PaymentProviderAuditAction =
  | 'platform.payment_provider.configured'
  | 'platform.payment_provider.activated'
  | 'platform.payment_provider.deactivated';

export interface PaymentProviderAudit {
  readonly actorUserId: string;
  readonly action: PaymentProviderAuditAction;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface SavePaymentProviderConfigurationInput {
  readonly provider: PaymentProvider;
  readonly environment: PaymentProviderEnvironment;
  readonly credentialsCiphertext: string;
  readonly credentialFields: readonly string[];
  readonly callbackUrl: string | null;
  readonly actorUserId: string;
  /** Null means "create"; a number is the version the caller read. */
  readonly expectedVersion: number | null;
  readonly now: Date;
  readonly audit: PaymentProviderAudit;
}

export type SavePaymentProviderConfigurationResult =
  | { readonly kind: 'saved'; readonly record: PaymentProviderConfigurationRecord }
  | { readonly kind: 'version_conflict' }
  | { readonly kind: 'active_conflict' };

export interface SetPaymentProviderActivationInput {
  readonly provider: PaymentProvider;
  readonly environment: PaymentProviderEnvironment;
  readonly active: boolean;
  readonly actorUserId: string;
  readonly now: Date;
  readonly audit: PaymentProviderAudit;
}

export type SetPaymentProviderActivationResult =
  | { readonly kind: 'updated'; readonly record: PaymentProviderConfigurationRecord }
  | { readonly kind: 'unchanged'; readonly record: PaymentProviderConfigurationRecord }
  | { readonly kind: 'not_configured' }
  | { readonly kind: 'callback_required' }
  | {
      readonly kind: 'other_environment_active';
      readonly environment: PaymentProviderEnvironment;
    };

export interface PaymentProviderStore {
  list(): Promise<readonly PaymentProviderConfigurationRecord[]>;
  find(
    provider: PaymentProvider,
    environment: PaymentProviderEnvironment,
  ): Promise<PaymentProviderConfigurationRecord | undefined>;
  save(
    input: SavePaymentProviderConfigurationInput,
  ): Promise<SavePaymentProviderConfigurationResult>;
  setActive(input: SetPaymentProviderActivationInput): Promise<SetPaymentProviderActivationResult>;
}
