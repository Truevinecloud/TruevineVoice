import { Inject, Injectable } from '@nestjs/common';
import { assertKnownAuditAction, isSafeAuditMetadata } from '@truevine/auth';
import type { Prisma, PrismaClient } from '@truevine/database';

import { DATABASE_CLIENT } from '../tokens.js';
import type { PaymentProvider, PaymentProviderEnvironment } from './payment-provider.contracts.js';
import type {
  PaymentProviderConfigurationRecord,
  PaymentProviderStore,
  SavePaymentProviderConfigurationInput,
  SavePaymentProviderConfigurationResult,
  SetPaymentProviderActivationInput,
  SetPaymentProviderActivationResult,
} from './payment-providers.store.js';

type PaymentProviderClient = Pick<
  PrismaClient,
  'paymentProviderConfiguration' | 'identityAuditEvent'
>;

type PaymentProviderDatabase = PaymentProviderClient & {
  $transaction<T>(work: (tx: PaymentProviderClient) => Promise<T>): Promise<T>;
};

interface ConfigurationRow {
  readonly id: string;
  readonly provider: PaymentProvider;
  readonly environment: PaymentProviderEnvironment;
  readonly credentialsCiphertext: string | null;
  readonly credentialFields: string[];
  readonly callbackUrl: string | null;
  readonly active: boolean;
  readonly configuredAt: Date | null;
  readonly activatedAt: Date | null;
  readonly deactivatedAt: Date | null;
  readonly version: number;
  readonly updatedAt: Date;
  readonly updatedByUserId: string;
  readonly updatedBy: { readonly email: string };
}

const CONFIGURATION_SELECT = {
  id: true,
  provider: true,
  environment: true,
  credentialsCiphertext: true,
  credentialFields: true,
  callbackUrl: true,
  active: true,
  configuredAt: true,
  activatedAt: true,
  deactivatedAt: true,
  version: true,
  updatedAt: true,
  updatedByUserId: true,
  updatedBy: { select: { email: true } },
} as const;

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { readonly code?: unknown }).code === 'P2002'
  );
}

function toRecord(row: ConfigurationRow): PaymentProviderConfigurationRecord {
  return {
    id: row.id,
    provider: row.provider,
    environment: row.environment,
    credentialsCiphertext: row.credentialsCiphertext,
    credentialFields: row.credentialFields,
    callbackUrl: row.callbackUrl,
    active: row.active,
    configuredAt: row.configuredAt,
    activatedAt: row.activatedAt,
    deactivatedAt: row.deactivatedAt,
    version: row.version,
    updatedAt: row.updatedAt,
    updatedByUserId: row.updatedByUserId,
    updatedByEmail: row.updatedBy.email,
  };
}

@Injectable()
export class PrismaPaymentProviderStore implements PaymentProviderStore {
  constructor(@Inject(DATABASE_CLIENT) private readonly prisma: PaymentProviderDatabase) {}

  async list(): Promise<readonly PaymentProviderConfigurationRecord[]> {
    const rows = await this.prisma.paymentProviderConfiguration.findMany({
      select: CONFIGURATION_SELECT,
      orderBy: [{ provider: 'asc' }, { environment: 'asc' }],
    });
    return rows.map((row) => toRecord(row));
  }

  async find(
    provider: PaymentProvider,
    environment: PaymentProviderEnvironment,
  ): Promise<PaymentProviderConfigurationRecord | undefined> {
    const row = await this.prisma.paymentProviderConfiguration.findUnique({
      where: { provider_environment: { provider, environment } },
      select: CONFIGURATION_SELECT,
    });
    return row ? toRecord(row) : undefined;
  }

  async save(
    input: SavePaymentProviderConfigurationInput,
  ): Promise<SavePaymentProviderConfigurationResult> {
    const audit = this.auditData(input.actorUserId, input.audit);

    if (input.expectedVersion === null) {
      try {
        return await this.prisma.$transaction<SavePaymentProviderConfigurationResult>(
          async (tx) => {
            const created = await tx.paymentProviderConfiguration.create({
              data: {
                provider: input.provider,
                environment: input.environment,
                credentialsCiphertext: input.credentialsCiphertext,
                credentialFields: [...input.credentialFields],
                callbackUrl: input.callbackUrl,
                configuredAt: input.now,
                updatedByUserId: input.actorUserId,
              },
              select: CONFIGURATION_SELECT,
            });

            await tx.identityAuditEvent.create({ data: audit });

            return { kind: 'saved', record: toRecord(created) };
          },
        );
      } catch (error) {
        // Two operators created the same provider/environment concurrently.
        // Neither may silently overwrite the other; the loser reloads.
        if (isUniqueViolation(error)) return { kind: 'version_conflict' };
        throw error;
      }
    }

    return this.prisma.$transaction<SavePaymentProviderConfigurationResult>(async (tx) => {
      const existing = await tx.paymentProviderConfiguration.findUnique({
        where: {
          provider_environment: {
            provider: input.provider,
            environment: input.environment,
          },
        },
        select: { id: true, active: true, version: true, configuredAt: true },
      });

      if (!existing) return { kind: 'version_conflict' };
      if (existing.active) return { kind: 'active_conflict' };
      if (existing.version !== input.expectedVersion) return { kind: 'version_conflict' };

      const result = await tx.paymentProviderConfiguration.updateMany({
        where: { id: existing.id, active: false, version: input.expectedVersion },
        data: {
          credentialsCiphertext: input.credentialsCiphertext,
          credentialFields: [...input.credentialFields],
          callbackUrl: input.callbackUrl,
          configuredAt: existing.configuredAt ?? input.now,
          version: { increment: 1 },
          updatedByUserId: input.actorUserId,
        },
      });

      if (result.count !== 1) {
        const current = await tx.paymentProviderConfiguration.findUnique({
          where: { id: existing.id },
          select: { active: true },
        });
        return current?.active ? { kind: 'active_conflict' } : { kind: 'version_conflict' };
      }

      const updated = await tx.paymentProviderConfiguration.findUniqueOrThrow({
        where: { id: existing.id },
        select: CONFIGURATION_SELECT,
      });
      await tx.identityAuditEvent.create({ data: audit });

      return { kind: 'saved', record: toRecord(updated) };
    });
  }

  async setActive(
    input: SetPaymentProviderActivationInput,
  ): Promise<SetPaymentProviderActivationResult> {
    const audit = this.auditData(input.actorUserId, input.audit);

    try {
      return await this.prisma.$transaction<SetPaymentProviderActivationResult>(async (tx) => {
        const existing = await tx.paymentProviderConfiguration.findUnique({
          where: {
            provider_environment: {
              provider: input.provider,
              environment: input.environment,
            },
          },
          select: CONFIGURATION_SELECT,
        });

        if (!existing) return { kind: 'not_configured' };

        if (input.active) {
          if (!existing.credentialsCiphertext || existing.credentialFields.length === 0) {
            return { kind: 'not_configured' };
          }
          if (!existing.callbackUrl) return { kind: 'callback_required' };
          if (existing.active) return { kind: 'unchanged', record: toRecord(existing) };

          const other = await tx.paymentProviderConfiguration.findFirst({
            where: {
              provider: input.provider,
              active: true,
              environment: { not: input.environment },
            },
            select: { environment: true },
          });
          if (other) {
            return { kind: 'other_environment_active', environment: other.environment };
          }

          const result = await tx.paymentProviderConfiguration.updateMany({
            where: { id: existing.id, active: false },
            data: {
              active: true,
              activatedAt: input.now,
              deactivatedAt: null,
              version: { increment: 1 },
            },
          });
          if (result.count !== 1) {
            return { kind: 'other_environment_active', environment: input.environment };
          }
        } else {
          if (!existing.active) return { kind: 'unchanged', record: toRecord(existing) };

          const result = await tx.paymentProviderConfiguration.updateMany({
            where: { id: existing.id, active: true },
            data: {
              active: false,
              deactivatedAt: input.now,
              version: { increment: 1 },
            },
          });
          if (result.count !== 1) return { kind: 'unchanged', record: toRecord(existing) };
        }

        const updated = await tx.paymentProviderConfiguration.findUniqueOrThrow({
          where: { id: existing.id },
          select: CONFIGURATION_SELECT,
        });
        await tx.identityAuditEvent.create({ data: audit });

        return { kind: 'updated', record: toRecord(updated) };
      });
    } catch (error) {
      // The partial unique index is the final word on one-active-environment-
      // per-provider. A concurrent activation that loses the race is reported
      // as the other environment being active, not as a 500.
      if (input.active && isUniqueViolation(error)) {
        const other = await this.prisma.paymentProviderConfiguration.findFirst({
          where: {
            provider: input.provider,
            active: true,
            environment: { not: input.environment },
          },
          select: { environment: true },
        });
        if (other) {
          return { kind: 'other_environment_active', environment: other.environment };
        }
      }
      throw error;
    }
  }

  private auditData(
    actorUserId: string,
    audit: SavePaymentProviderConfigurationInput['audit'],
  ): {
    actorUserId: string;
    action: string;
    outcome: 'SUCCESS';
    metadata: Prisma.InputJsonValue;
  } {
    if (audit.actorUserId !== actorUserId) {
      throw new Error('Payment-provider audit actor does not match the mutation actor.');
    }
    assertKnownAuditAction(audit.action);
    if (!isSafeAuditMetadata(audit.metadata)) {
      throw new Error('Refusing to write unsafe payment-provider audit metadata.');
    }
    return {
      actorUserId,
      action: audit.action,
      outcome: 'SUCCESS',
      metadata: audit.metadata as unknown as Prisma.InputJsonValue,
    };
  }
}
