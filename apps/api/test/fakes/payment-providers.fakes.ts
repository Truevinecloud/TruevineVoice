import type {
  PaymentProvider,
  PaymentProviderEnvironment,
} from '../../src/payments/payment-provider.contracts.js';
import type {
  PaymentProviderAudit,
  PaymentProviderConfigurationRecord,
  PaymentProviderStore,
  SavePaymentProviderConfigurationInput,
  SavePaymentProviderConfigurationResult,
  SetPaymentProviderActivationInput,
  SetPaymentProviderActivationResult,
} from '../../src/payments/payment-providers.store.js';

/**
 * In-memory {@link PaymentProviderStore} for unit and HTTP tests.
 *
 * It enforces the same invariants the Prisma store does - version compare-and-
 * set, refusal to update an active row, one active environment per provider -
 * so a service test cannot pass against a fake that is more permissive than
 * production.
 */
export class FakePaymentProviderStore implements PaymentProviderStore {
  rows: PaymentProviderConfigurationRecord[] = [];
  audits: PaymentProviderAudit[] = [];
  private sequence = 0;

  async list(): Promise<readonly PaymentProviderConfigurationRecord[]> {
    return this.rows.map((row) => ({ ...row }));
  }

  async find(
    provider: PaymentProvider,
    environment: PaymentProviderEnvironment,
  ): Promise<PaymentProviderConfigurationRecord | undefined> {
    const row = this.row(provider, environment);
    return row ? { ...row } : undefined;
  }

  async save(
    input: SavePaymentProviderConfigurationInput,
  ): Promise<SavePaymentProviderConfigurationResult> {
    const existing = this.row(input.provider, input.environment);

    if (input.expectedVersion === null) {
      if (existing) return { kind: 'version_conflict' };
      this.sequence += 1;
      const record: PaymentProviderConfigurationRecord = {
        id: `payment-config-${this.sequence}`,
        provider: input.provider,
        environment: input.environment,
        credentialsCiphertext: input.credentialsCiphertext,
        credentialFields: [...input.credentialFields],
        callbackUrl: input.callbackUrl,
        active: false,
        configuredAt: input.now,
        activatedAt: null,
        deactivatedAt: null,
        version: 1,
        updatedAt: input.now,
        updatedByUserId: input.actorUserId,
        updatedByEmail: 'owner@truevine.test',
      };
      this.rows.push(record);
      this.audits.push(input.audit);
      return { kind: 'saved', record: { ...record } };
    }

    if (!existing) return { kind: 'version_conflict' };
    if (existing.active) return { kind: 'active_conflict' };
    if (existing.version !== input.expectedVersion) return { kind: 'version_conflict' };

    const updated: PaymentProviderConfigurationRecord = {
      ...existing,
      credentialsCiphertext: input.credentialsCiphertext,
      credentialFields: [...input.credentialFields],
      callbackUrl: input.callbackUrl,
      configuredAt: existing.configuredAt ?? input.now,
      version: existing.version + 1,
      updatedAt: input.now,
      updatedByUserId: input.actorUserId,
    };
    this.replace(updated);
    this.audits.push(input.audit);
    return { kind: 'saved', record: { ...updated } };
  }

  async setActive(
    input: SetPaymentProviderActivationInput,
  ): Promise<SetPaymentProviderActivationResult> {
    const existing = this.row(input.provider, input.environment);
    if (!existing) return { kind: 'not_configured' };

    if (input.active) {
      if (!existing.credentialsCiphertext || existing.credentialFields.length === 0) {
        return { kind: 'not_configured' };
      }
      if (!existing.callbackUrl) return { kind: 'callback_required' };
      if (existing.active) return { kind: 'unchanged', record: { ...existing } };

      const other = this.rows.find(
        (row) =>
          row.provider === input.provider && row.environment !== input.environment && row.active,
      );
      if (other) {
        return { kind: 'other_environment_active', environment: other.environment };
      }
    } else if (!existing.active) {
      return { kind: 'unchanged', record: { ...existing } };
    }

    const updated: PaymentProviderConfigurationRecord = {
      ...existing,
      active: input.active,
      activatedAt: input.active ? input.now : existing.activatedAt,
      deactivatedAt: input.active ? null : input.now,
      version: existing.version + 1,
      updatedAt: input.now,
    };
    this.replace(updated);
    this.audits.push(input.audit);
    return { kind: 'updated', record: { ...updated } };
  }

  private row(
    provider: PaymentProvider,
    environment: PaymentProviderEnvironment,
  ): PaymentProviderConfigurationRecord | undefined {
    return this.rows.find((row) => row.provider === provider && row.environment === environment);
  }

  private replace(next: PaymentProviderConfigurationRecord): void {
    const index = this.rows.findIndex((row) => row.id === next.id);
    if (index >= 0) this.rows[index] = next;
  }
}
