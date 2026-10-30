import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  InternalServerErrorException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { assertKnownAuditAction, isSafeAuditMetadata, type AuditAction } from '@truevine/auth';

import type { AuditStore } from '../auth/auth.store.js';
import { AUDIT_STORE } from '../auth/tokens.js';
import {
  environmentLabel,
  isPaymentEnvironment,
  isPaymentProvider,
  PAYMENT_ENVIRONMENTS,
  PAYMENT_PROVIDER_CONTRACTS,
  PAYMENT_PROVIDERS,
  type PaymentProvider,
  type PaymentProviderEnvironment,
} from './payment-provider.contracts.js';
import { PaymentCredentialDecryptionError, type CredentialCipher } from './credential-cipher.js';
import type {
  PaymentProviderConfigurationRecord,
  PaymentProviderStore,
} from './payment-providers.store.js';
import { PAYMENT_CREDENTIAL_CIPHER, PAYMENT_PROVIDER_STORE } from './tokens.js';

const MAX_CALLBACK_URL_LENGTH = 512;

const CONNECTION_TESTING = Object.freeze({
  available: false,
  code: 'not_available',
  reason:
    'No reviewed MTN or Airtel client is linked in this build. Connection testing is disabled rather than reporting a simulated success.',
});

const READ_ACTIONS = {
  list: 'platform.payment_provider.configurations_viewed',
  detail: 'platform.payment_provider.configuration_viewed',
} as const satisfies Record<string, AuditAction>;

export type PaymentProviderStatus = 'NOT_CONFIGURED' | 'CONFIGURED' | 'ACTIVE';
export type ActivationBlockedReason = 'credentials_required' | 'callback_url_required';

export interface PaymentCredentialFieldView {
  readonly name: string;
  readonly label: string;
  readonly secret: boolean;
  readonly present: boolean;
}

export interface PaymentEnvironmentView {
  readonly provider: PaymentProvider;
  readonly environment: PaymentProviderEnvironment;
  readonly environmentLabel: string;
  readonly status: PaymentProviderStatus;
  readonly active: boolean;
  readonly configured: boolean;
  readonly credentialsPresent: boolean;
  readonly credentialFields: readonly PaymentCredentialFieldView[];
  readonly callbackUrl: string | null;
  readonly configuredAt: string | null;
  readonly activatedAt: string | null;
  readonly deactivatedAt: string | null;
  readonly updatedAt: string | null;
  readonly updatedBy: { readonly userId: string; readonly email: string } | null;
  readonly activationBlockedReason: ActivationBlockedReason | null;
}

export interface PaymentProviderView {
  readonly provider: PaymentProvider;
  readonly displayName: string;
  readonly detail: string;
  readonly environments: readonly PaymentEnvironmentView[];
}

export interface PaymentProvidersView {
  readonly providers: readonly PaymentProviderView[];
  readonly connectionTesting: typeof CONNECTION_TESTING;
}

function invalid(code: string, message: string): never {
  throw new BadRequestException({ error: { code, message } });
}

function conflict(code: string, message: string): never {
  throw new ConflictException({ error: { code, message } });
}

function requireProvider(value: unknown): PaymentProvider {
  if (!isPaymentProvider(value)) {
    invalid('invalid_provider', 'Select a supported payment provider.');
  }
  return value;
}

function requireEnvironment(value: unknown): PaymentProviderEnvironment {
  if (!isPaymentEnvironment(value)) {
    invalid('invalid_environment', 'Select Sandbox or Production.');
  }
  return value;
}

function requireObject(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    invalid('invalid_request', 'A configuration request body is required.');
  }
  return value as Record<string, unknown>;
}

function requireOnlyKeys(body: Record<string, unknown>, allowed: readonly string[]): void {
  for (const key of Object.keys(body)) {
    if (!allowed.includes(key))
      invalid('invalid_request', 'The request contains an unknown field.');
  }
}

function requireCallbackUrl(value: unknown): string {
  if (typeof value !== 'string') {
    invalid('invalid_callback_url', 'The callback URL must be an HTTPS URL.');
  }

  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_CALLBACK_URL_LENGTH) {
    invalid(
      'invalid_callback_url',
      'The callback URL must be an HTTPS URL of at most 512 characters.',
    );
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    invalid('invalid_callback_url', 'The callback URL must be an HTTPS URL.');
  }

  if (url.protocol !== 'https:') {
    invalid('invalid_callback_url', 'The callback URL must use HTTPS.');
  }
  if (url.username.length > 0 || url.password.length > 0) {
    invalid('invalid_callback_url', 'The callback URL must not contain credentials.');
  }
  if (url.search.length > 0 || url.hash.length > 0) {
    invalid(
      'invalid_callback_url',
      'The callback URL must not contain a query string or fragment.',
    );
  }
  if (url.hostname.length === 0) {
    invalid('invalid_callback_url', 'The callback URL must name a host.');
  }

  const normalized = url.toString();
  // Mirror the database CHECK exactly. `new URL` accepts a bare "?" or "#" as an
  // empty query/fragment for which `search`/`hash` are empty, so the earlier
  // checks do not catch it; the CHECK constraint does, and without this the
  // insert would fail as a 500 instead of a validation error.
  if (!/^https:\/\/[^\s#?]+$/.test(normalized)) {
    invalid(
      'invalid_callback_url',
      'The callback URL must not contain a query string or fragment.',
    );
  }

  return normalized;
}

function optionalIso(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

/**
 * Rejects control characters without embedding them in a regular expression.
 *
 * A credential with a newline or NUL would corrupt the encrypted JSON and, in a
 * header-building adapter, could split a header. `no-control-regex` exists for
 * the same reason this is a loop rather than a character class.
 */
function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

/** A payment-provider status view that never contains a credential value. */
function viewFor(
  provider: PaymentProvider,
  environment: PaymentProviderEnvironment,
  row: PaymentProviderConfigurationRecord | undefined,
): PaymentEnvironmentView {
  const contract = PAYMENT_PROVIDER_CONTRACTS[provider];
  const configured =
    row !== undefined && row.credentialsCiphertext !== null && row.credentialFields.length > 0;
  const active = row?.active === true;
  const status: PaymentProviderStatus = active
    ? 'ACTIVE'
    : configured
      ? 'CONFIGURED'
      : 'NOT_CONFIGURED';

  return {
    provider,
    environment,
    environmentLabel: environmentLabel(environment),
    status,
    active,
    configured,
    credentialsPresent: configured,
    credentialFields: contract.credentialFields.map((field) => ({
      name: field.name,
      label: field.label,
      secret: field.secret,
      present: row?.credentialFields.includes(field.name) === true,
    })),
    callbackUrl: row?.callbackUrl ?? null,
    configuredAt: optionalIso(row?.configuredAt ?? null),
    activatedAt: optionalIso(row?.activatedAt ?? null),
    deactivatedAt: optionalIso(row?.deactivatedAt ?? null),
    updatedAt: optionalIso(row?.updatedAt ?? null),
    updatedBy: row ? { userId: row.updatedByUserId, email: row.updatedByEmail } : null,
    activationBlockedReason: active
      ? null
      : !configured
        ? 'credentials_required'
        : row?.callbackUrl === null || row?.callbackUrl === undefined
          ? 'callback_url_required'
          : null,
  };
}

@Injectable()
export class PaymentProvidersService {
  constructor(
    @Inject(PAYMENT_PROVIDER_STORE) private readonly store: PaymentProviderStore,
    @Inject(PAYMENT_CREDENTIAL_CIPHER) private readonly cipher: CredentialCipher,
    @Inject(AUDIT_STORE) private readonly audit: AuditStore,
  ) {}

  async list(actorUserId: string): Promise<PaymentProvidersView> {
    const rows = await this.store.list();
    await this.recordRead(actorUserId, READ_ACTIONS.list, {
      configurationCount: rows.length,
    });

    return {
      providers: PAYMENT_PROVIDERS.map((provider) => {
        const contract = PAYMENT_PROVIDER_CONTRACTS[provider];
        return {
          provider,
          displayName: contract.displayName,
          detail: contract.detail,
          environments: PAYMENT_ENVIRONMENTS.map((environment) =>
            viewFor(
              provider,
              environment,
              rows.find((row) => row.provider === provider && row.environment === environment),
            ),
          ),
        };
      }),
      connectionTesting: CONNECTION_TESTING,
    };
  }

  async read(
    actorUserId: string,
    rawProvider: unknown,
    rawEnvironment: unknown,
  ): Promise<{
    readonly configuration: PaymentEnvironmentView;
    readonly connectionTesting: typeof CONNECTION_TESTING;
  }> {
    const provider = requireProvider(rawProvider);
    const environment = requireEnvironment(rawEnvironment);
    const row = await this.store.find(provider, environment);

    await this.recordRead(actorUserId, READ_ACTIONS.detail, { provider, environment });

    return {
      configuration: viewFor(provider, environment, row),
      connectionTesting: CONNECTION_TESTING,
    };
  }

  async save(
    actorUserId: string,
    rawProvider: unknown,
    rawEnvironment: unknown,
    rawBody: unknown,
  ): Promise<{
    readonly configuration: PaymentEnvironmentView;
    readonly connectionTesting: typeof CONNECTION_TESTING;
  }> {
    const provider = requireProvider(rawProvider);
    const environment = requireEnvironment(rawEnvironment);
    this.requireCipher();

    const body = requireObject(rawBody);
    requireOnlyKeys(body, ['credentials', 'callbackUrl']);

    const existing = await this.store.find(provider, environment);
    if (existing?.active) {
      conflict('provider_active', 'Deactivate this environment before changing its credentials.');
    }

    const contract = PAYMENT_PROVIDER_CONTRACTS[provider];
    const rawCredentials = body['credentials'];
    if (
      rawCredentials !== undefined &&
      rawCredentials !== null &&
      (typeof rawCredentials !== 'object' || Array.isArray(rawCredentials))
    ) {
      invalid('invalid_credentials', 'Credentials must be provided as an object.');
    }

    const providedCredentials =
      rawCredentials === undefined || rawCredentials === null
        ? {}
        : (rawCredentials as Record<string, unknown>);

    for (const name of Object.keys(providedCredentials)) {
      if (!contract.credentialFields.some((field) => field.name === name)) {
        invalid('invalid_credentials', 'The request contains an unknown credential field.');
      }
    }

    let current: Readonly<Record<string, string>> = {};
    if (existing?.credentialsCiphertext) {
      try {
        current = this.cipher.decrypt(provider, environment, existing.credentialsCiphertext);
      } catch (error) {
        if (error instanceof PaymentCredentialDecryptionError) {
          throw new InternalServerErrorException({
            error: {
              code: 'credential_decryption_failed',
              message:
                'Stored credentials cannot be opened with the configured key. No change was made.',
            },
          });
        }
        throw error;
      }
    }

    const merged: Record<string, string> = { ...current };
    const savedFields: string[] = [];

    for (const field of contract.credentialFields) {
      const value = providedCredentials[field.name];
      if (value === undefined || value === null) continue;
      if (typeof value !== 'string') {
        invalid('invalid_credentials', `The ${field.label} must be text.`);
      }

      const trimmed = value.trim();
      // A blank field on update means "keep the saved value". The API never
      // accepts a blank credential as a replacement for a configured one.
      if (trimmed.length === 0) continue;

      if (trimmed.length > field.maxLength) {
        invalid(
          'invalid_credentials',
          `The ${field.label} exceeds the ${field.maxLength}-character limit.`,
        );
      }
      if (hasControlCharacter(trimmed)) {
        invalid('invalid_credentials', `The ${field.label} contains a control character.`);
      }

      merged[field.name] = trimmed;
      savedFields.push(field.name);
    }

    const missing = contract.credentialFields.filter(
      (field) => field.required && (merged[field.name] ?? '').length === 0,
    );
    if (missing.length > 0) {
      invalid(
        'invalid_credentials',
        `Missing required credentials: ${missing.map((field) => field.label).join(', ')}.`,
      );
    }

    let callbackUrl = existing?.callbackUrl ?? null;
    let callbackChanged = false;
    if (Object.prototype.hasOwnProperty.call(body, 'callbackUrl')) {
      const rawCallback = body['callbackUrl'];
      callbackUrl =
        rawCallback === null || rawCallback === '' ? null : requireCallbackUrl(rawCallback);
      callbackChanged = true;
    }

    if (savedFields.length === 0 && !callbackChanged) {
      invalid('nothing_to_update', 'Provide a credential or callback URL to save.');
    }

    const credentialsCiphertext = this.cipher.encrypt(provider, environment, merged);
    const credentialFields = contract.credentialFields
      .map((field) => field.name)
      .filter((name) => (merged[name] ?? '').length > 0);

    const metadata = {
      provider,
      environment,
      savedFields,
      callbackConfigured: callbackUrl !== null,
      version: (existing?.version ?? 0) + 1,
    };
    assertKnownAuditAction('platform.payment_provider.configured');
    if (!isSafeAuditMetadata(metadata)) {
      throw new Error('Refusing to write unsafe payment-provider audit metadata.');
    }

    const result = await this.store.save({
      provider,
      environment,
      credentialsCiphertext,
      credentialFields,
      callbackUrl,
      actorUserId,
      expectedVersion: existing ? existing.version : null,
      now: new Date(),
      audit: {
        actorUserId,
        action: 'platform.payment_provider.configured',
        metadata,
      },
    });

    if (result.kind === 'active_conflict') {
      conflict('provider_active', 'Deactivate this environment before changing its credentials.');
    }
    if (result.kind === 'version_conflict') {
      conflict(
        'configuration_changed',
        'Another administrator changed this configuration. Reload and try again.',
      );
    }

    return {
      configuration: viewFor(provider, environment, result.record),
      connectionTesting: CONNECTION_TESTING,
    };
  }

  async setActive(
    actorUserId: string,
    rawProvider: unknown,
    rawEnvironment: unknown,
    rawBody: unknown,
  ): Promise<{
    readonly configuration: PaymentEnvironmentView;
    readonly connectionTesting: typeof CONNECTION_TESTING;
  }> {
    const provider = requireProvider(rawProvider);
    const environment = requireEnvironment(rawEnvironment);
    const body = requireObject(rawBody);
    requireOnlyKeys(body, ['active']);

    if (typeof body['active'] !== 'boolean') {
      invalid('invalid_activation', 'Provide active as true or false.');
    }
    const active = body['active'];

    const existing = await this.store.find(provider, environment);
    if (!existing) {
      conflict(
        'not_configured',
        'Save credentials and a callback URL before activating this environment.',
      );
    }
    if (!existing.credentialsCiphertext || existing.credentialFields.length === 0) {
      conflict(
        'not_configured',
        'Save credentials and a callback URL before activating this environment.',
      );
    }
    if (active && existing.callbackUrl === null) {
      conflict('callback_url_required', 'Save a callback URL before activating this environment.');
    }
    if (existing.active === active) {
      return {
        configuration: viewFor(provider, environment, existing),
        connectionTesting: CONNECTION_TESTING,
      };
    }

    const action = active
      ? 'platform.payment_provider.activated'
      : 'platform.payment_provider.deactivated';
    const metadata = {
      provider,
      environment,
      previousStatus: existing.active ? 'ACTIVE' : 'CONFIGURED',
    };
    assertKnownAuditAction(action);
    if (!isSafeAuditMetadata(metadata)) {
      throw new Error('Refusing to write unsafe payment-provider audit metadata.');
    }

    const result = await this.store.setActive({
      provider,
      environment,
      active,
      actorUserId,
      now: new Date(),
      audit: { actorUserId, action, metadata },
    });

    if (result.kind === 'not_configured') {
      conflict(
        'not_configured',
        'Save credentials and a callback URL before activating this environment.',
      );
    }
    if (result.kind === 'callback_required') {
      conflict('callback_url_required', 'Save a callback URL before activating this environment.');
    }
    if (result.kind === 'other_environment_active') {
      conflict(
        'other_environment_active',
        `${environmentLabel(result.environment)} is already active for this provider. Deactivate it first.`,
      );
    }

    return {
      configuration: viewFor(provider, environment, result.record),
      connectionTesting: CONNECTION_TESTING,
    };
  }

  private requireCipher(): void {
    if (!this.cipher.available) {
      throw new ServiceUnavailableException({
        error: {
          code: 'credential_encryption_unavailable',
          message:
            'Payment-provider credential encryption is not configured. Set PAYMENT_CREDENTIAL_ENCRYPTION_KEY before saving credentials.',
        },
      });
    }
  }

  private async recordRead(
    actorUserId: string,
    action: (typeof READ_ACTIONS)[keyof typeof READ_ACTIONS],
    metadata: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    assertKnownAuditAction(action);
    if (!isSafeAuditMetadata(metadata)) {
      throw new Error('Refusing to write unsafe payment-provider audit metadata.');
    }
    await this.audit.recordIdentity({
      actorUserId,
      action,
      outcome: 'SUCCESS',
      metadata,
    });
  }
}
