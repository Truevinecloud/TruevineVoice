/**
 * Campaign preparation against real PostgreSQL only.
 *
 * This suite does not boot the HTTP stack, does not connect to Redis, does not
 * contact a voice provider and does not touch a wallet service. It drives
 * `PrismaCampaignStore` directly so the transaction, row locks, unique indexes
 * and immutability triggers are the things under test.
 *
 * It is deliberately pinned to a dedicated disposable database. The shared
 * development database `truevine_voice` is rejected even though the generic
 * harness allowlists it, and an additional opt-in is required.
 *
 * Prerequisites (all must be approved by the operator):
 *   - a migrated, disposable PostgreSQL database named exactly
 *     `rbac_security_20261122_120000_campaignprep`;
 *   - NODE_ENV=test;
 *   - DATABASE_URL pointing at 127.0.0.1:55432 and that exact database;
 *   - CAMPAIGN_PREPARATION_DISPOSABLE=1.
 *
 * No migration, database, container or fixture is created by this file. All
 * fixture data is synthetic and uses fresh UUIDs on every run. Rows protected by
 * append-only/immutability triggers cannot be removed; their identifiers are
 * unique so they cannot collide with later runs.
 */

import { randomUUID } from 'node:crypto';

import { createDatabaseClient, type PrismaClient } from '@truevine/database';
import { loadEnvFiles, requireEnv } from '@truevine/shared';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { BillingService } from '../src/billing/billing.service.js';
import { CampaignsService } from '../src/campaigns/campaigns.service.js';
import { CampaignNotEditableError } from '../src/campaigns/campaign.store.js';
import { PrismaCampaignStore } from '../src/campaigns/prisma-campaign.store.js';
import { ContactsService } from '../src/contacts/contacts.service.js';
import { AudioService } from '../src/audio/audio.service.js';
import { PrismaOperationsStore } from '../src/operations/prisma-operations.store.js';
import {
  assertConnectedToDisposableDatabase,
  assertDisposableDatabase,
  DISPOSABLE_DATABASE_PORT,
} from './disposable-database.js';

/** The only database this suite may reach. Never `truevine_voice`. */
const DISPOSABLE_DATABASE = 'rbac_security_20261122_120000_campaignprep';
const OPT_IN = 'CAMPAIGN_PREPARATION_DISPOSABLE';

const RUN = randomUUID().replaceAll('-', '').slice(0, 12);
const PHONE_PREFIX = BigInt(`0x${RUN}`) % 10_000_000_000n;
let phoneSequence = 0;

const ORG_A = randomUUID();
const ORG_B = randomUUID();
const ORG_SUSPENDED = randomUUID();
const OWNER_A = randomUUID();
const OWNER_B = randomUUID();
const OWNER_SUSPENDED = randomUUID();
const OPERATOR = randomUUID();

let database: PrismaClient;
let store: PrismaCampaignStore;
let operations: PrismaOperationsStore;

function nextPhone(): string {
  const suffix = String((PHONE_PREFIX + BigInt(phoneSequence++)) % 10_000_000_000n).padStart(
    10,
    '0',
  );
  return `+2567${suffix}`;
}

/**
 * A stricter wrapper around the repository guard. The generic guard permits the
 * shared `truevine_voice` database; this suite does not.
 */
function assertCampaignPreparationDatabase(url: string, environment: string | undefined) {
  if (process.env['RBAC_ISOLATED_QA'])
    throw new Error('RBAC_ISOLATED_QA must not be set for campaign preparation e2e.');
  if (process.env[OPT_IN] !== '1')
    throw new Error(`Set ${OPT_IN}=1 only for the pinned disposable preparation database.`);

  const expected = assertDisposableDatabase(url, environment);
  if (expected.name !== DISPOSABLE_DATABASE)
    throw new Error(
      `Refusing to run against "${expected.name}"; this suite is pinned to "${DISPOSABLE_DATABASE}".`,
    );

  const parsed = new URL(url);
  if (
    parsed.hostname !== '127.0.0.1' ||
    parsed.port !== DISPOSABLE_DATABASE_PORT ||
    parsed.search ||
    parsed.hash
  )
    throw new Error('Refusing to run against anything other than 127.0.0.1:55432 with no URL parameters.');

  return expected;
}

async function successAudits(organizationId: string, campaignId: string): Promise<number> {
  return database.securityAuditEvent.count({
    where: {
      organizationId,
      action: 'campaign.prepared',
      outcome: 'SUCCESS',
      targetId: campaignId,
    },
  });
}

async function walletSnapshot(organizationId: string) {
  const rows = await database.walletEntry.findMany({
    where: { organizationId },
    select: { id: true, amountMinor: true, currency: true, reference: true },
    orderBy: { id: 'asc' },
  });
  return JSON.stringify(rows);
}

/** Creates a fresh group, consented contacts and a draft campaign for one test. */
async function fixture(input: {
  readonly organizationId: string;
  readonly ownerUserId: string;
  readonly eligibleCount?: number;
}) {
  const eligibleCount = input.eligibleCount ?? 3;
  const campaignId = randomUUID();
  const groupId = randomUUID();
  const audioId = randomUUID();
  const eligible: Array<{ id: string; destination: string }> = [];
  const suppressed: Array<{ id: string; destination: string }> = [];
  const noConsent: Array<{ id: string; destination: string }> = [];
  const now = new Date();

  await database.$transaction(async (tx) => {
    await tx.contactGroup.create({
      data: {
        organizationId: input.organizationId,
        id: groupId,
        name: `Prep group ${groupId}`,
        normalizedName: groupId,
        createdById: input.ownerUserId,
      },
    });

    await tx.audioAsset.create({
      data: {
        organizationId: input.organizationId,
        id: audioId,
        createdById: input.ownerUserId,
        name: `Prep audio ${audioId}`,
        source: 'RECORDING',
        mimeType: 'audio/wav',
        storageKey: `${input.organizationId}/audio/${audioId}`,
        checksumSha256: 'a'.repeat(64),
        byteSize: 1n,
      },
    });

    const addContact = async (kind: 'eligible' | 'suppressed' | 'no-consent') => {
      const id = randomUUID();
      const destination = nextPhone();
      await tx.contact.create({
        data: {
          organizationId: input.organizationId,
          id,
          phoneE164: destination,
          destination,
          label: `Synthetic ${kind}`,
          createdById: input.ownerUserId,
          voiceConsentAt: kind === 'no-consent' ? null : now,
          voiceConsentSource: kind === 'no-consent' ? null : 'synthetic',
          voiceConsentPurpose: kind === 'no-consent' ? null : 'campaign',
          suppressedAt: kind === 'suppressed' ? now : null,
        },
      });
      await tx.contactGroupMember.create({
        data: { organizationId: input.organizationId, groupId, contactId: id },
      });
      const contact = { id, destination };
      if (kind === 'eligible') eligible.push(contact);
      if (kind === 'suppressed') suppressed.push(contact);
      if (kind === 'no-consent') noConsent.push(contact);
    };

    for (let index = 0; index < eligibleCount; index += 1) await addContact('eligible');
    await addContact('suppressed');
    await addContact('no-consent');

    await tx.campaign.create({
      data: {
        organizationId: input.organizationId,
        id: campaignId,
        name: `Preparation ${campaignId}`,
        status: 'DRAFT',
        scheduledAt: new Date(Date.now() + 30 * 60 * 1000),
        retryMaxAttempts: 1,
        retryDelayMinutes: 60,
        audioOrganizationId: input.organizationId,
        audioAssetId: audioId,
        createdById: input.ownerUserId,
        audienceGroups: {
          create: { organizationId: input.organizationId, groupId },
        },
      },
    });
  });

  return {
    organizationId: input.organizationId,
    ownerUserId: input.ownerUserId,
    campaignId,
    groupId,
    audioId,
    eligible,
    suppressed,
    noConsent,
    input: {
      organizationId: input.organizationId,
      campaignId,
      actorUserId: input.ownerUserId,
    },
  };
}

beforeAll(async () => {
  loadEnvFiles();
  const url = requireEnv('DATABASE_URL');
  const expected = assertCampaignPreparationDatabase(url, process.env['NODE_ENV']);

  database = createDatabaseClient(url, { log: [] });
  await assertConnectedToDisposableDatabase(
    async () =>
      (await database.$queryRaw<{ name: string }[]>`SELECT current_database() AS name`)[0]?.name,
    expected,
  );

  await database.$transaction(async (tx) => {
    await tx.user.create({
      data: { id: OWNER_A, email: `prep-owner-a-${RUN}@example.invalid`, passwordHash: 'unusable' },
    });
    await tx.user.create({
      data: { id: OWNER_B, email: `prep-owner-b-${RUN}@example.invalid`, passwordHash: 'unusable' },
    });
    await tx.user.create({
      data: {
        id: OWNER_SUSPENDED,
        email: `prep-owner-suspended-${RUN}@example.invalid`,
        passwordHash: 'unusable',
      },
    });
    await tx.user.create({
      data: { id: OPERATOR, email: `prep-operator-${RUN}@example.invalid`, passwordHash: 'unusable' },
    });

    await tx.organization.create({
      data: { id: ORG_A, slug: `prep-a-${RUN}`, name: 'Preparation A' },
    });
    await tx.organization.create({
      data: { id: ORG_B, slug: `prep-b-${RUN}`, name: 'Preparation B' },
    });
    await tx.organization.create({
      data: {
        id: ORG_SUSPENDED,
        slug: `prep-suspended-${RUN}`,
        name: 'Preparation suspended',
        suspendedAt: new Date(),
      },
    });

    await tx.membership.create({
      data: { organizationId: ORG_A, userId: OWNER_A, role: 'OWNER' },
    });
    await tx.membership.create({
      data: { organizationId: ORG_B, userId: OWNER_B, role: 'OWNER' },
    });
    await tx.membership.create({
      data: { organizationId: ORG_SUSPENDED, userId: OWNER_SUSPENDED, role: 'OWNER' },
    });
    await tx.platformRoleAssignment.create({
      data: { userId: OPERATOR, role: 'OPERATIONS_ADMIN', grantedByUserId: OWNER_A },
    });
  });

  store = new PrismaCampaignStore(database);
  operations = new PrismaOperationsStore(database);
});

afterAll(async () => {
  // Audit rows, executions and recipients are immutable by design. All fixtures
  // use fresh identifiers, so leaving them in the disposable database is safe.
  await database?.$disconnect();
});

describe('campaign preparation on a pinned disposable PostgreSQL database', () => {
  it('creates the execution and eligible recipient snapshot atomically', async () => {
    const f = await fixture({ organizationId: ORG_A, ownerUserId: OWNER_A });

    const prepared = await store.prepareCampaign(f.input);

    expect(prepared).toMatchObject({
      organizationId: ORG_A,
      campaignId: f.campaignId,
      recipientCount: f.eligible.length,
      replayed: false,
      campaign: { status: 'DRAFT' },
    });
    expect(await database.campaignExecution.count({ where: { organizationId: ORG_A, campaignId: f.campaignId } })).toBe(1);
    expect(await database.campaignRecipient.count({ where: { organizationId: ORG_A, campaignId: f.campaignId } })).toBe(f.eligible.length);

    const recipients = await database.campaignRecipient.findMany({
      where: { organizationId: ORG_A, campaignId: f.campaignId },
      select: { contactId: true, destination: true },
      orderBy: { contactId: 'asc' },
    });
    expect(recipients.map((row) => row.contactId).sort()).toEqual(f.eligible.map((row) => row.id).sort());
    expect(recipients.every((row) => /^\+[1-9][0-9]{0,14}$/.test(row.destination))).toBe(true);
    expect((await database.campaign.findUniqueOrThrow({
      where: { organizationId_id: { organizationId: ORG_A, id: f.campaignId } },
      select: { status: true, emergencyStoppedAt: true },
    })).status).toBe('DRAFT');
    expect(await successAudits(ORG_A, f.campaignId)).toBe(1);
  });

  it('rolls back the execution and all recipients when a recipient insert fails', async () => {
    const f = await fixture({ organizationId: ORG_A, ownerUserId: OWNER_A });
    const sentinelId = randomUUID();

    // No execution exists, but a recipient row already occupies the unique
    // (organization, campaign, contact) slot. The first createMany therefore
    // fails and the whole transaction must leave no new durable intent.
    await database.campaignRecipient.create({
      data: {
        organizationId: ORG_A,
        id: sentinelId,
        campaignId: f.campaignId,
        contactId: f.eligible[0]!.id,
        destination: f.eligible[0]!.destination,
      },
    });

    await expect(store.prepareCampaign(f.input)).rejects.toThrow();

    expect(await database.campaignExecution.count({ where: { organizationId: ORG_A, campaignId: f.campaignId } })).toBe(0);
    expect(await database.campaignRecipient.count({ where: { organizationId: ORG_A, campaignId: f.campaignId } })).toBe(1);
    expect(await database.campaignRecipient.findUnique({
      where: { organizationId_id: { organizationId: ORG_A, id: sentinelId } },
      select: { id: true },
    })).toMatchObject({ id: sentinelId });
    expect(await successAudits(ORG_A, f.campaignId)).toBe(0);
    expect((await database.campaign.findUniqueOrThrow({
      where: { organizationId_id: { organizationId: ORG_A, id: f.campaignId } },
      select: { status: true },
    })).status).toBe('DRAFT');
  });

  it('serializes concurrent preparation requests to one execution and idempotent replays', async () => {
    const f = await fixture({ organizationId: ORG_A, ownerUserId: OWNER_A, eligibleCount: 4 });
    const attempts = Array.from({ length: 6 }, () => store.prepareCampaign(f.input));

    const results = await Promise.all(attempts);

    expect(results).toHaveLength(6);
    expect(results.filter((row) => !row!.replayed)).toHaveLength(1);
    expect(results.filter((row) => row!.replayed)).toHaveLength(5);
    expect(new Set(results.map((row) => row!.executionId)).size).toBe(1);
    expect(results.every((row) => row!.recipientCount === f.eligible.length)).toBe(true);
    expect(await database.campaignExecution.count({ where: { organizationId: ORG_A, campaignId: f.campaignId } })).toBe(1);
    expect(await database.campaignRecipient.count({ where: { organizationId: ORG_A, campaignId: f.campaignId } })).toBe(f.eligible.length);
  });

  it('prevents a second execution and a duplicate recipient at the database level', async () => {
    const f = await fixture({ organizationId: ORG_A, ownerUserId: OWNER_A });
    const first = await store.prepareCampaign(f.input);
    const recipient = await database.campaignRecipient.findFirstOrThrow({
      where: { organizationId: ORG_A, campaignId: f.campaignId },
      select: { contactId: true, destination: true },
    });

    await expect(database.$executeRaw`
      INSERT INTO campaign_executions (organization_id, id, campaign_id)
      VALUES (${ORG_A}::uuid, ${randomUUID()}::uuid, ${f.campaignId}::uuid)
    `).rejects.toThrow();
    await expect(database.$executeRaw`
      INSERT INTO campaign_recipients (organization_id, id, campaign_id, contact_id, destination)
      VALUES (${ORG_A}::uuid, ${randomUUID()}::uuid, ${f.campaignId}::uuid, ${recipient.contactId}::uuid, ${recipient.destination})
    `).rejects.toThrow();

    expect(await database.campaignExecution.count({ where: { organizationId: ORG_A, campaignId: f.campaignId } })).toBe(1);
    expect(await database.campaignRecipient.count({ where: { organizationId: ORG_A, campaignId: f.campaignId } })).toBe(first!.recipientCount);
  });

  it('keeps recipient snapshots immutable and independent of later contact edits', async () => {
    const f = await fixture({ organizationId: ORG_A, ownerUserId: OWNER_A });
    await store.prepareCampaign(f.input);
    const before = await database.campaignRecipient.findFirstOrThrow({
      where: { organizationId: ORG_A, campaignId: f.campaignId },
      orderBy: { id: 'asc' },
      select: { id: true, contactId: true, destination: true },
    });
    const alternate = nextPhone();

    await expect(database.$executeRaw`
      UPDATE campaign_recipients SET destination=${alternate}
      WHERE organization_id=${ORG_A}::uuid AND id=${before.id}::uuid
    `).rejects.toThrow();
    await expect(database.$executeRaw`
      DELETE FROM campaign_recipients
      WHERE organization_id=${ORG_A}::uuid AND id=${before.id}::uuid
    `).rejects.toThrow();

    await database.contact.update({
      where: { organizationId_id: { organizationId: ORG_A, id: before.contactId } },
      data: { destination: alternate },
    });

    const after = await database.campaignRecipient.findUniqueOrThrow({
      where: { organizationId_id: { organizationId: ORG_A, id: before.id } },
      select: { destination: true },
    });
    expect(after.destination).toBe(before.destination);
  });

  it('refuses cross-tenant reads, writes and actors', async () => {
    const f = await fixture({ organizationId: ORG_A, ownerUserId: OWNER_A });
    await store.prepareCampaign(f.input);

    expect(await store.findCampaignPreparation(ORG_B, f.campaignId)).toBeUndefined();
    expect(
      await store.prepareCampaign({
        organizationId: ORG_B,
        actorUserId: OWNER_B,
        campaignId: f.campaignId,
      }),
    ).toBeUndefined();

    await expect(
      store.prepareCampaign({
        organizationId: ORG_A,
        actorUserId: OWNER_B,
        campaignId: f.campaignId,
      }),
    ).rejects.toMatchObject({ code: 'permission_denied' });

    expect(await database.campaignExecution.count({ where: { organizationId: ORG_B, campaignId: f.campaignId } })).toBe(0);
    expect(await database.campaignRecipient.count({ where: { organizationId: ORG_B, campaignId: f.campaignId } })).toBe(0);
    expect(await database.campaignExecution.count({ where: { organizationId: ORG_A, campaignId: f.campaignId } })).toBe(1);
  });

  it('rejects preparation inside a suspended organization without writing intent', async () => {
    const f = await fixture({
      organizationId: ORG_SUSPENDED,
      ownerUserId: OWNER_SUSPENDED,
    });

    await expect(store.prepareCampaign(f.input)).rejects.toMatchObject({
      code: 'permission_denied',
    });

    expect(await database.campaignExecution.count({ where: { organizationId: ORG_SUSPENDED, campaignId: f.campaignId } })).toBe(0);
    expect(await database.campaignRecipient.count({ where: { organizationId: ORG_SUSPENDED, campaignId: f.campaignId } })).toBe(0);
    expect(await successAudits(ORG_SUSPENDED, f.campaignId)).toBe(0);
  });

  it('keeps emergency-stop behavior separate from preparation', async () => {
    const prepared = await fixture({ organizationId: ORG_A, ownerUserId: OWNER_A });
    await store.prepareCampaign(prepared.input);

    const draftStop = await operations.emergencyStop({
      organizationId: ORG_A,
      campaignId: prepared.campaignId,
      actorUserId: OPERATOR,
      reasonCode: 'security_incident',
      stoppedAt: new Date(),
      justification: 'Synthetic compatibility check',
    });
    expect(draftStop).toMatchObject({ kind: 'not_active' });

    const active = await fixture({ organizationId: ORG_A, ownerUserId: OWNER_A });
    await database.campaign.update({
      where: { organizationId_id: { organizationId: ORG_A, id: active.campaignId } },
      data: { status: 'ACTIVE' },
    });
    const stopped = await operations.emergencyStop({
      organizationId: ORG_A,
      campaignId: active.campaignId,
      actorUserId: OPERATOR,
      reasonCode: 'provider_incident',
      stoppedAt: new Date(),
      justification: 'Synthetic compatibility check',
    });
    expect(stopped).toMatchObject({ kind: 'stopped', campaign: { status: 'PAUSED' } });

    await expect(store.prepareCampaign(active.input)).rejects.toThrow(CampaignNotEditableError);
    expect(await database.campaignExecution.count({ where: { organizationId: ORG_A, campaignId: active.campaignId } })).toBe(0);

    const stillDraft = await database.campaign.findUniqueOrThrow({
      where: { organizationId_id: { organizationId: ORG_A, id: prepared.campaignId } },
      select: { status: true, emergencyStoppedAt: true },
    });
    expect(stillDraft).toMatchObject({ status: 'DRAFT', emergencyStoppedAt: null });
  });

  it('performs no wallet, provider, network or dispatch job side effects', async () => {
    const f = await fixture({ organizationId: ORG_A, ownerUserId: OWNER_A });
    const walletBefore = await walletSnapshot(ORG_A);
    const attemptsBefore = await database.callAttempt.count({ where: { organizationId: ORG_A } });
    const operationsBefore = await database.callOperation.count({ where: { organizationId: ORG_A } });
    const eventsBefore = await database.callEvent.count({ where: { organizationId: ORG_A } });

    const billing = {
      wallet: vi.fn(() => {
        throw new Error('Preparation must not read the wallet.');
      }),
    } as unknown as BillingService;
    const contacts = {
      countEligibleForCampaign: vi.fn(async () => f.eligible.length),
    } as unknown as ContactsService;
    const audio = {
      voices: vi.fn(() => ({ available: true, storageAvailable: true, voices: [] })),
    } as unknown as AudioService;
    const service = new CampaignsService(store, contacts, billing, audio, database);
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    let view;
    try {
      view = await service.prepare(ORG_A, OWNER_A, f.campaignId);
    } finally {
      fetchSpy.mockRestore();
    }

    expect(view).toMatchObject({
      campaignId: f.campaignId,
      status: 'DRAFT',
      prepared: true,
      dispatchEnabled: false,
      recipientCount: f.eligible.length,
    });
    expect(billing.wallet).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await walletSnapshot(ORG_A)).toBe(walletBefore);
    expect(await database.callAttempt.count({ where: { organizationId: ORG_A } })).toBe(attemptsBefore);
    expect(await database.callOperation.count({ where: { organizationId: ORG_A } })).toBe(operationsBefore);
    expect(await database.callEvent.count({ where: { organizationId: ORG_A } })).toBe(eventsBefore);
  });
});
