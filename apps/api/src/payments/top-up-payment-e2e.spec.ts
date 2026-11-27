/**
 * Isolated database integration tests for W5-02 synthetic payment integration.
 *
 * These tests are GATED and do not run by default. They require:
 *   W502_E2E_ENABLED=true
 *   W502_E2E_DATABASE_URL=<isolated test database URL>
 *
 * They must never run against truevine_voice. They use the real Prisma client
 * and real services against an isolated database to prove database-level
 * atomicity and exactly-once settlement, which mock-based unit tests cannot.
 */

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createDatabaseClient, type PrismaClient } from '@truevine/database';

import { PrismaBillingStore, type BillingDatabase } from '../billing/prisma-billing.store.js';
import { BillingService } from '../billing/billing.service.js';
import { PrismaPaymentIntentStore } from '../payments/prisma-payment-intents.store.js';
import { TopUpIntegrationService } from '../payments/top-up-integration.service.js';
import { TopUpReconciliation } from '../payments/top-up-reconciliation.js';
import { signSyntheticCallback, SYNTHETIC_ENVIRONMENT, SYNTHETIC_PROVIDER, type SyntheticCallbackPayload } from '../payments/top-up-reconciliation.js';

const _E2E_ENABLED = process.env.W502_E2E_ENABLED === 'true';
const E2E_DATABASE_URL = process.env.W502_E2E_DATABASE_URL ?? '';
const KEY = 'e2e-synthetic-key-0001';

function syntheticPayload(overrides: Partial<SyntheticCallbackPayload> = {}): SyntheticCallbackPayload {
  return {
    provider: SYNTHETIC_PROVIDER,
    environment: SYNTHETIC_ENVIRONMENT,
    eventId: `e2e-${randomUUID()}`,
    status: 'SUCCESS',
    amountMinor: '10000',
    currency: 'UGX',
    ...overrides,
  } as SyntheticCallbackPayload;
}

function assertIsolatedDatabase(url: string): void {
  const blocked = /truevine_voice(?!_w402|_payment)/i.test(url);
  const allowed = /truevine_w402_integration_test|truevine_payment_e2e/i.test(url);
  if (blocked || !allowed) {
    throw new Error(`E2E database URL must be an isolated test database, got: ${url}`);
  }
}

const e2eSuite = describe.skipIf(!_E2E_ENABLED);

async function cleanupE2EOrg(prisma: PrismaClient, orgId: string): Promise<void> {
  try {
    await prisma.$executeRawUnsafe(`DELETE FROM wallet_entries WHERE organization_id = $1 AND reference LIKE 'payment-topup:%'`, orgId);
    await prisma.$executeRawUnsafe(`DELETE FROM payment_attempts WHERE organization_id = $1`, orgId);
    await prisma.$executeRawUnsafe(`DELETE FROM payment_provider_events WHERE organization_id = $1`, orgId);
    await prisma.$executeRawUnsafe(`DELETE FROM payment_intents WHERE organization_id = $1`, orgId);
    await prisma.$executeRawUnsafe(`DELETE FROM top_up_requests WHERE organization_id = $1`, orgId);
    await prisma.$executeRawUnsafe(`DELETE FROM organizations WHERE id = $1`, orgId);
  } catch {
    // Organization may not exist yet.
  }
}

e2eSuite('w5-02e isolated payment e2e', () => {
  let prisma: PrismaClient;
  let service: TopUpIntegrationService;

  const orgId = randomUUID();
  const userId = randomUUID();
  const actorId = userId;
  const idempotencyKey = randomUUID();
  const amountMinor = 10000n;

  beforeAll(async () => {
    assertIsolatedDatabase(E2E_DATABASE_URL);
    prisma = createDatabaseClient(E2E_DATABASE_URL);
    const billingStore = new PrismaBillingStore(prisma as unknown as BillingDatabase);
    const billing = new BillingService(billingStore);
    const paymentIntentsStore = new PrismaPaymentIntentStore(prisma as unknown as PrismaClient);
    const reconciliation = new TopUpReconciliation(prisma as unknown as PrismaClient, KEY);
    service = new TopUpIntegrationService(billing, paymentIntentsStore, prisma as unknown as PrismaClient, reconciliation);

    await cleanupE2EOrg(prisma, orgId);

    await prisma.user.create({
      data: {
        id: userId,
        email: `e2e-${userId}@example.test`,
        passwordHash: 'test-hash',
      },
    });
    await prisma.organization.create({
      data: {
        id: orgId,
        slug: `e2e-${orgId}`,
        name: 'W5-02E E2E Test Org',
        memberships: {
          create: {
            userId: userId,
            role: 'OWNER',
          },
        },
      },
    });
  });

  afterAll(async () => {
    await cleanupE2EOrg(prisma, orgId);
    await prisma.$disconnect();
  });

  it('creates a top-up request and payment intent in the same organization', async () => {
    const result = await service.createIntentFromTopUp({
      organizationId: orgId,
      actorUserId: actorId,
      amountMinor,
      idempotencyKey,
    });

    expect(result.topUpRequest.organizationId).toBe(orgId);
    expect(String(result.topUpRequest.amountMinor)).toBe(amountMinor.toString());
    expect(result.intent.organizationId).toBe(orgId);
    expect(String(result.intent.amountMinor)).toBe(amountMinor.toString());
    expect(result.intent.currency).toBe('UGX');
    expect(result.intent.status).toBe('PENDING');
    expect(result.intent.providerReference).toBe(`synthetic:${idempotencyKey}`);
  });

  it('does not create duplicate payment intents for repeated top-up requests', async () => {
    await service.createIntentFromTopUp({
      organizationId: orgId,
      actorUserId: actorId,
      amountMinor,
      idempotencyKey,
    });

    const intentsForOrg = await prisma.paymentIntent.findMany({
      where: { organizationId: orgId, idempotencyKey },
    });
    expect(intentsForOrg).toHaveLength(1);
  });

  it('credits exactly once on successful synthetic settlement', async () => {
    const eventId = `e2e-${randomUUID()}`;
    const payload = syntheticPayload({
      eventId,
      providerReference: `synthetic:${idempotencyKey}`,
      status: 'SUCCESS',
      amountMinor: amountMinor.toString(),
    });
    const callback = { ...payload, signature: signSyntheticCallback(payload, KEY) };

    const result = await service.reconcileSyntheticTopUp(callback, KEY);

    expect(result.outcome).toBe('CREDITED');
    expect(result.eventId).toBe(eventId);
    expect(result.walletEntryId).not.toBeNull();

    const credits = await prisma.walletEntry.findMany({
      where: { organizationId: orgId, reference: `payment-topup:${SYNTHETIC_PROVIDER}:${eventId}` },
    });
    expect(credits).toHaveLength(1);
    expect(String(credits[0]!.amountMinor)).toBe(amountMinor.toString());
  });

  it('rejects cross-tenant intent status reads', async () => {
    const crossKey = randomUUID();
    const result = await service.createIntentFromTopUp({
      organizationId: orgId,
      actorUserId: actorId,
      amountMinor,
      idempotencyKey: crossKey,
    });

    const crossOrgId = randomUUID();
    const crossStatus = await service.getIntentStatus(crossOrgId, result.intent.id);
    expect(crossStatus).toBeNull();

    const ownStatus = await service.getIntentStatus(orgId, result.intent.id);
    expect(ownStatus).toBe('PENDING');
  });
});