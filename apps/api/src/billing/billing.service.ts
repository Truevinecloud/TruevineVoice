import { BadRequestException, ConflictException, Inject, Injectable } from '@nestjs/common';
import {
  BILLING_STORE,
  type BillingProfile,
  type BillingStore,
  type TopUpRecord,
} from './billing.store.js';

function invalid(message: string): never {
  throw new BadRequestException({ error: { code: 'invalid_billing', message } });
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function requireUuid(value: unknown): string {
  if (typeof value !== 'string' || !UUID.test(value))
    invalid('A valid request identifier is required.');
  return value;
}
@Injectable()
export class BillingService {
  constructor(@Inject(BILLING_STORE) private readonly store: BillingStore) {}

  async wallet(organizationId: string) {
    return { currency: 'UGX', amountMinor: (await this.store.balance(organizationId)).toString() };
  }
  async transactions(organizationId: string, cursor?: string) {
    if (cursor !== undefined) requireUuid(cursor);
    const rows = await this.store.transactions(organizationId, cursor);
    const entries = rows.slice(0, 50);
    return {
      entries: entries.map((row) => ({
        ...row,
        amountMinor: row.amountMinor.toString(),
        createdAt: row.createdAt.toISOString(),
      })),
      nextCursor: rows.length > 50 ? entries.at(-1)!.id : null,
    };
  }
  async billing(organizationId: string) {
    const [profile, topUps] = await Promise.all([
      this.store.profile(organizationId),
      this.store.topUps(organizationId),
    ]);
    return {
      profile,
      topUps: topUps.map((row) => this.topUpView(row)),
      collectionAvailable: false,
    };
  }
  async saveProfile(organizationId: string, input: unknown) {
    if (!input || typeof input !== 'object') invalid('Billing details are required.');
    const body = input as Record<string, unknown>;
    const profile: BillingProfile = {
      name: this.text(body.name, 200, 'Billing name'),
      email: this.text(body.email, 254, 'Billing email'),
      address: this.text(body.address, 500, 'Billing address'),
    };
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(profile.email))
      invalid('A valid billing email is required.');
    return this.store.saveProfile(organizationId, profile);
  }
  async requestTopUp(organizationId: string, createdById: string, input: unknown) {
    if (!input || typeof input !== 'object') invalid('Top-up details are required.');
    const body = input as Record<string, unknown>;
    // Strings avoid JSON number precision loss. Currency is fixed, never supplied by the caller.
    if (
      body.currency !== 'UGX' ||
      typeof body.amountMinor !== 'string' ||
      !/^[1-9][0-9]{0,18}$/.test(body.amountMinor)
    )
      invalid('Enter a positive whole UGX amount as text.');
    const amountMinor = BigInt(body.amountMinor);
    if (amountMinor > 9223372036854775807n) invalid('Top-up amount exceeds the supported limit.');
    const idempotencyKey = requireUuid(body.idempotencyKey);
    const row = await this.store.requestTopUp({
      organizationId,
      createdById,
      amountMinor,
      idempotencyKey,
    });
    if (row.amountMinor !== amountMinor || row.currency !== 'UGX')
      throw new ConflictException({
        error: {
          code: 'idempotency_conflict',
          message: 'This request identifier was already used for a different amount.',
        },
      });
    return this.topUpView(row);
  }
  private topUpView(row: TopUpRecord) {
    return {
      id: row.id,
      amountMinor: row.amountMinor.toString(),
      currency: row.currency,
      status: 'PENDING' as const,
      createdAt: row.createdAt.toISOString(),
    };
  }
  private text(value: unknown, limit: number, label: string): string {
    if (typeof value !== 'string' || !value.trim() || value.trim().length > limit)
      invalid(`${label} is required and must be at most ${limit} characters.`);
    return value.trim();
  }
}
