import { randomBytes, randomUUID } from 'node:crypto';

import type { PrismaClient } from '@truevine/database';
import {
  bindCallbackSession,
  CALLBACK_SOURCES,
  recordCallEvent,
  type CallSql,
} from '@truevine/telephony';

/** All fixtures are synthetic and uniquely suffixed; append-only history is left in place. */
export interface W503FixtureGraph {
  readonly organizationId: string;
  readonly userId: string;
  readonly campaignId: string;
  readonly contactId: string;
  readonly recipientId: string;
  readonly executionId: string;
  readonly campaignName: string;
}

export interface W503AttemptFixture {
  readonly attemptId: string;
  readonly createdAt: Date;
}

export interface W503UsageFixture {
  readonly usageEventId: string;
  readonly debitEntryId: string;
  readonly creditEntryId: string | null;
  readonly eventKey: string;
  readonly chargeMinor: bigint;
}

export type W503AttemptState = 'QUEUED' | 'COMPLETED' | 'NO_ANSWER' | 'FAILED';

interface GraphOptions {
  readonly campaignName?: string;
  readonly campaignCreatedAt?: Date;
}

interface AttemptOptions {
  readonly state?: W503AttemptState;
  readonly createdAt?: Date;
  readonly duplicateFinalEvent?: boolean;
}

interface UsageOptions {
  readonly chargeMinor: bigint;
  readonly providerCostMinor?: bigint | null;
  readonly reversed?: boolean;
  readonly billedSeconds?: number;
  readonly ratePerSecondMinor?: bigint;
  readonly occurredAt?: Date;
  readonly debitEntryId?: string;
  /** Reuse an existing synthetic debit to exercise duplicate-link rejection. */
  readonly reuseExistingDebitEntry?: boolean;
  /** Creates deliberate ledger/usage inconsistency for negative acceptance cases. */
  readonly debitAmountOverrideMinor?: bigint;
}

const TRANSITIONS: Readonly<Record<Exclude<W503AttemptState, 'QUEUED'>, readonly string[]>> = {
  COMPLETED: ['DIALING', 'RINGING', 'ANSWERED', 'COMPLETED'],
  NO_ANSWER: ['DIALING', 'RINGING', 'NO_ANSWER'],
  FAILED: ['DIALING', 'FAILED'],
};

function uuid(): string {
  return randomUUID();
}

function eventKey(): string {
  return `w503-${uuid()}`;
}

export async function createW503Graph(
  db: PrismaClient,
  options: GraphOptions = {},
): Promise<W503FixtureGraph> {
  const suffix = uuid();
  const user = await db.user.create({
    data: { id: uuid(), email: `w503-${suffix}@example.test`, passwordHash: 'test-hash' },
  });
  const organization = await db.organization.create({
    data: {
      id: uuid(),
      slug: `w503-${suffix}`,
      name: 'W5-03 Integration Test Org',
      memberships: { create: { userId: user.id, role: 'OWNER' } },
    },
  });
  const campaignName = options.campaignName ?? 'W5-03 Test Campaign';
  const campaign = await db.campaign.create({
    data: {
      organizationId: organization.id,
      id: uuid(),
      name: campaignName,
      status: 'ACTIVE',
      createdById: user.id,
      ...(options.campaignCreatedAt ? { createdAt: options.campaignCreatedAt } : {}),
    },
  });
  const contact = await db.contact.create({
    data: {
      organizationId: organization.id,
      id: uuid(),
      destination: '+12025550123',
      createdById: user.id,
    },
  });
  const recipient = await db.campaignRecipient.create({
    data: {
      organizationId: organization.id,
      id: uuid(),
      campaignId: campaign.id,
      contactId: contact.id,
      destination: '+12025550123',
    },
  });
  const execution = await db.campaignExecution.create({
    data: { organizationId: organization.id, id: uuid(), campaignId: campaign.id },
  });

  return {
    organizationId: organization.id,
    userId: user.id,
    campaignId: campaign.id,
    contactId: contact.id,
    recipientId: recipient.id,
    executionId: execution.id,
    campaignName,
  };
}

export async function createW503Attempt(
  db: PrismaClient,
  graph: W503FixtureGraph,
  options: AttemptOptions = {},
): Promise<W503AttemptFixture> {
  const state = options.state ?? 'COMPLETED';
  const createdAt = options.createdAt ?? new Date();

  // Campaign executions are unique per campaign, but recipients are not. A
  // fresh recipient for each attempt keeps every synthetic call a valid
  // initial attempt under the call-persistence database trigger.
  const contact = await db.contact.create({
    data: {
      organizationId: graph.organizationId,
      id: uuid(),
      destination: '+12025550123',
      createdById: graph.userId,
    },
  });
  const recipient = await db.campaignRecipient.create({
    data: {
      organizationId: graph.organizationId,
      id: uuid(),
      campaignId: graph.campaignId,
      contactId: contact.id,
      destination: '+12025550123',
    },
  });

  const attempt = await db.callAttempt.create({
    data: {
      organizationId: graph.organizationId,
      id: uuid(),
      campaignId: graph.campaignId,
      executionId: graph.executionId,
      recipientId: recipient.id,
      destination: '+12025550123',
      attemptNumber: 1,
      createdAt,
    },
  });

  if (state === 'QUEUED') return { attemptId: attempt.id, createdAt };

  let finalKey = '';
  for (const next of TRANSITIONS[state]) {
    finalKey = eventKey();
    await db.$transaction((tx) =>
      recordCallEvent(tx as unknown as CallSql, {
        organizationId: graph.organizationId,
        attemptId: attempt.id,
        eventKey: finalKey,
        state: next as 'DIALING' | 'RINGING' | 'ANSWERED' | 'COMPLETED' | 'NO_ANSWER' | 'FAILED',
        occurredAt: createdAt,
      }),
    );
  }
  if (options.duplicateFinalEvent) {
    await db.$transaction((tx) =>
      recordCallEvent(tx as unknown as CallSql, {
        organizationId: graph.organizationId,
        attemptId: attempt.id,
        eventKey: finalKey,
        state: state as 'COMPLETED' | 'NO_ANSWER' | 'FAILED',
        occurredAt: createdAt,
      }),
    );
  }

  return { attemptId: attempt.id, createdAt };
}

export async function createW503Usage(
  db: PrismaClient,
  graph: W503FixtureGraph,
  attemptId: string,
  options: UsageOptions,
): Promise<W503UsageFixture> {
  const suffix = uuid();
  const session = `session-${suffix}`;
  const key = randomBytes(32).toString('hex');
  const charge = options.chargeMinor;
  // One-second fixtures keep the database charge formula exact for every
  // integer minor-unit amount, including deliberately odd values.
  const billedSeconds = options.billedSeconds ?? 1;
  const rate = options.ratePerSecondMinor ?? charge / BigInt(billedSeconds);
  const cost = options.providerCostMinor ?? null;
  const occurredAt = options.occurredAt ?? new Date();
  const usageId = uuid();
  const quoteId = uuid();
  const debitEntryId = options.debitEntryId ?? uuid();
  const debitAmount = options.debitAmountOverrideMinor ?? -charge;

  await db.$transaction((tx) =>
    bindCallbackSession(
      tx as unknown as CallSql,
      CALLBACK_SOURCES.synthetic,
      session,
      graph.organizationId,
      attemptId,
    ),
  );

  await db.$executeRaw`
    INSERT INTO voice_usage_quotes (
      organization_id, id, source, session_id, attempt_id, billed_seconds,
      rate_per_second_minor, customer_charge_minor, currency,
      provider_cost_minor, provider_cost_currency, pricing_version
    )
    VALUES (
      ${graph.organizationId}::uuid, ${quoteId}::uuid, ${CALLBACK_SOURCES.synthetic}, ${session},
      ${attemptId}::uuid, ${billedSeconds}, ${rate.toString()}::bigint,
      ${charge.toString()}::bigint, 'UGX', ${cost?.toString() ?? null}::bigint,
      ${cost === null ? null : 'UGX'}, 'w503-test-v1'
    )`;

  if (!options.reuseExistingDebitEntry) {
    await db.$executeRaw`
      INSERT INTO wallet_entries (organization_id, id, amount_minor, currency, reference, description)
      VALUES (
        ${graph.organizationId}::uuid, ${debitEntryId}::uuid, ${debitAmount.toString()}::bigint,
        'UGX', ${`voice-usage:${graph.organizationId}:${key}`}, 'W5-03 synthetic voice debit'
      )`;
  }

  await db.$executeRaw`
    INSERT INTO voice_usage_events (
      organization_id, id, attempt_id, source, session_id, receipt_event_key,
      quote_id, debit_entry_id, billed_seconds, rate_per_second_minor,
      customer_charge_minor, currency, provider_cost_minor, provider_cost_currency,
      pricing_version, state, occurred_at
    )
    VALUES (
      ${graph.organizationId}::uuid, ${usageId}::uuid, ${attemptId}::uuid,
      ${CALLBACK_SOURCES.synthetic}, ${session}, ${key}, ${quoteId}::uuid,
      ${debitEntryId}::uuid, ${billedSeconds}, ${rate.toString()}::bigint,
      ${charge.toString()}::bigint, 'UGX', ${cost?.toString() ?? null}::bigint,
      ${cost === null ? null : 'UGX'}, 'w503-test-v1',
      'COMPLETED'::"CallAttemptState", ${occurredAt}
    )`;

  // An unlinked top-up credit proves unrelated wallet transactions are excluded.
  await db.walletEntry.create({
    data: {
      organizationId: graph.organizationId,
      id: uuid(),
      amountMinor: 100_000n,
      currency: 'UGX',
      reference: `w503-topup-${suffix}`,
      description: 'W5-03 synthetic top-up credit',
    },
  });

  let creditEntryId: string | null = null;
  if (options.reversed) {
    creditEntryId = uuid();
    await db.$executeRaw`
      INSERT INTO wallet_entries (organization_id, id, amount_minor, currency, reference, description)
      VALUES (
        ${graph.organizationId}::uuid, ${creditEntryId}::uuid, ${charge.toString()}::bigint,
        'UGX', ${`voice-usage-reversal:${graph.organizationId}:${key}`},
        'W5-03 synthetic usage reversal'
      )`;
    await db.$executeRaw`
      INSERT INTO voice_usage_reversals (organization_id, id, usage_event_id, credit_entry_id, reason)
      VALUES (
        ${graph.organizationId}::uuid, ${uuid()}::uuid, ${usageId}::uuid,
        ${creditEntryId}::uuid, 'W5-03 synthetic reversal'
      )`;
  }

  return { usageEventId: usageId, debitEntryId, creditEntryId, eventKey: key, chargeMinor: charge };
}

export function noCleanupRequired(): void {
  // Call history and wallet entries are append-only; unique synthetic fixtures remain.
}
