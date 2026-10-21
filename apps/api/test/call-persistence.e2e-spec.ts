import { randomUUID } from 'node:crypto';
import { createDatabaseClient, type PrismaClient } from '@truevine/database';
import { loadEnvFiles, requireEnv } from '@truevine/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CallPersistence, type CallDatabase } from '../src/calls/call-persistence.js';
import {
  assertConnectedToDisposableDatabase,
  assertDisposableDatabase,
} from './disposable-database.js';

describe('call persistence on disposable PostgreSQL', () => {
  let db: PrismaClient;
  let store: CallPersistence;
  beforeAll(async () => {
    loadEnvFiles();
    const url = requireEnv('DATABASE_URL');
    const expected = assertDisposableDatabase(url, process.env['NODE_ENV']);
    if (process.env['CI'] !== 'true' && process.env['CALL_PERSISTENCE_DISPOSABLE'] !== '1')
      throw new Error('Set CALL_PERSISTENCE_DISPOSABLE=1 only for a disposable test database.');
    db = createDatabaseClient(url, { log: [] });
    await assertConnectedToDisposableDatabase(
      async () =>
        (await db.$queryRaw<{ name: string }[]>`SELECT current_database() AS name`)[0]?.name,
      expected,
    );
    store = new CallPersistence(db);
  });
  afterAll(async () => {
    await db?.$disconnect();
  });

  async function fixture() {
    const org = randomUUID(),
      user = randomUUID(),
      campaign = randomUUID();
    await db.$transaction(async (tx) => {
      await tx.user.create({
        data: { id: user, email: user + '@example.invalid', passwordHash: 'unusable' },
      });
      await tx.organization.create({ data: { id: org, slug: org, name: 'Disposable call test' } });
      await tx.membership.create({ data: { organizationId: org, userId: user, role: 'OWNER' } });
      await tx.campaign.create({
        data: { organizationId: org, id: campaign, name: 'Synthetic', createdById: user },
      });
    });
    const contact = await store.createContact(org, '+256700000001', 'Synthetic');
    const recipient = await store.addRecipient(org, campaign, contact.id);
    return {
      org,
      user,
      campaign,
      contact,
      recipient,
      input: {
        organizationId: org,
        campaignId: campaign,
        recipientId: recipient.id,
        idempotencyKey: randomUUID(),
      },
    };
  }

  it('replays concurrent identical acceptance and persists exactly one operation/attempt', async () => {
    const f = await fixture();
    const results = await Promise.all(Array.from({ length: 6 }, () => store.accept(f.input)));
    expect(results.every((result) => JSON.stringify(result) === JSON.stringify(results[0]))).toBe(
      true,
    );
    expect(await db.callAttempt.count({ where: { organizationId: f.org } })).toBe(1);
    expect(await db.callOperation.count({ where: { organizationId: f.org } })).toBe(1);
    // Fresh connection and service: replay is not process-local memory.
    const restarted = createDatabaseClient(requireEnv('DATABASE_URL'), { log: [] });
    try {
      expect(await new CallPersistence(restarted).accept(f.input)).toEqual(results[0]);
    } finally {
      await restarted.$disconnect();
    }
  });

  it('rejects different parameters under the same key, including concurrent different campaigns', async () => {
    const f = await fixture();
    const second = await db.campaign.create({
      data: {
        organizationId: f.org,
        name: 'Second',
        createdById: f.user,
      },
    });
    const recipient = await store.addRecipient(f.org, second.id, f.contact.id);
    const changed = { ...f.input, campaignId: second.id, recipientId: recipient.id };
    const results = await Promise.allSettled([store.accept(f.input), store.accept(changed)]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected');
    expect(rejected?.status === 'rejected' && rejected.reason).toMatchObject({
      code: 'idempotency_conflict',
    });
    expect(await db.callAttempt.count({ where: { organizationId: f.org } })).toBe(1);
  });

  it('prevents accidental duplicate execution across different keys, even concurrently', async () => {
    const f = await fixture();
    const results = await Promise.allSettled([
      store.accept(f.input),
      store.accept({ ...f.input, idempotencyKey: 'different-key' }),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected');
    expect(rejected?.status === 'rejected' && rejected.reason).toMatchObject({
      code: 'duplicate_execution',
    });
    expect(await db.campaignExecution.count({ where: { organizationId: f.org } })).toBe(1);
  });

  it('permits the same key independently across organizations', async () => {
    const a = await fixture(),
      b = await fixture();
    const first = await store.accept({ ...a.input, idempotencyKey: 'shared-key' });
    const second = await store.accept({ ...b.input, idempotencyKey: 'shared-key' });
    expect(second.organizationId).not.toBe(first.organizationId);
    expect(second.attemptId).not.toBe(first.attemptId);
    await expect(db.$executeRaw`
      INSERT INTO call_operations(organization_id,operation,key,fingerprint_version,fingerprint,attempt_id,result)
      VALUES (${a.org}::uuid,'call.accept','other',1,${'a'.repeat(64)},${second.attemptId}::uuid,'{}')`).rejects.toThrow();
  });

  it('rolls back attempt and execution if operation persistence fails, then safely retries', async () => {
    const f = await fixture();
    const failing: CallDatabase = {
      $queryRaw: db.$queryRaw.bind(db),
      $executeRaw: db.$executeRaw.bind(db),
      $transaction: (body) =>
        db.$transaction((tx) =>
          body({
            $queryRaw: tx.$queryRaw.bind(tx),
            $executeRaw: async (sql, ...values) => {
              if (sql.join('').includes('INSERT INTO call_operations'))
                throw new Error('injected write failure');
              return tx.$executeRaw(sql, ...values);
            },
          }),
        ),
    };
    await expect(new CallPersistence(failing).accept(f.input)).rejects.toThrow(
      'injected write failure',
    );
    expect(await db.callOperation.count({ where: { organizationId: f.org } })).toBe(0);
    expect(await db.callAttempt.count({ where: { organizationId: f.org } })).toBe(0);
    expect(await db.campaignExecution.count({ where: { organizationId: f.org } })).toBe(0);
    expect((await store.accept(f.input)).attemptNumber).toBe(1);
  });

  it('rejects cross-tenant repository access and database parent references', async () => {
    const a = await fixture(),
      b = await fixture();
    await expect(store.addRecipient(a.org, a.campaign, b.contact.id)).rejects.toMatchObject({
      code: 'not_found',
    });
    await expect(store.accept({ ...a.input, recipientId: b.recipient.id })).rejects.toMatchObject({
      code: 'not_found',
    });
    await expect(store.updateContact(a.org, b.contact.id, '+256700000003')).rejects.toMatchObject({
      code: 'not_found',
    });
    await expect(
      db.campaignRecipient.create({
        data: {
          organizationId: a.org,
          campaignId: b.campaign,
          contactId: a.contact.id,
          destination: a.contact.destination,
        },
      }),
    ).rejects.toThrow();
    const call = await store.accept(b.input);
    await expect(
      store.recordEvent({
        organizationId: a.org,
        attemptId: call.attemptId,
        eventKey: 'foreign',
        state: 'DIALING',
        occurredAt: new Date(),
      }),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('keeps snapshots and accepted identities immutable despite contact/campaign edits', async () => {
    const f = await fixture();
    const accepted = await store.accept(f.input);
    await store.updateContact(f.org, f.contact.id, '+256700000002');
    await db.campaign.update({
      where: { organizationId_id: { organizationId: f.org, id: f.campaign } },
      data: { name: 'Edited' },
    });
    expect(await store.addRecipient(f.org, f.campaign, f.contact.id)).toEqual(f.recipient);
    expect(await store.accept(f.input)).toEqual(accepted);
    await expect(
      db.campaignRecipient.update({
        where: { organizationId_id: { organizationId: f.org, id: f.recipient.id } },
        data: { destination: '+256700000002' },
      }),
    ).rejects.toThrow();
    await expect(
      db.callAttempt.update({
        where: { organizationId_id: { organizationId: f.org, id: accepted.attemptId } },
        data: { destination: '+256700000002' },
      }),
    ).rejects.toThrow();
    await expect(
      db.campaign.delete({
        where: { organizationId_id: { organizationId: f.org, id: f.campaign } },
      }),
    ).rejects.toThrow();
    await expect(
      db.contact.delete({
        where: { organizationId_id: { organizationId: f.org, id: f.contact.id } },
      }),
    ).rejects.toThrow();
  });

  it('requires an explicit terminal predecessor/reason for redials and prevents concurrent forks', async () => {
    const f = await fixture();
    const initial = await store.accept(f.input);
    const redial = {
      ...f.input,
      idempotencyKey: 'redial',
      previousAttemptId: initial.attemptId,
      redialReason: 'Operator requested redial',
    };
    await expect(store.accept(redial)).rejects.toMatchObject({ code: 'invalid_redial' });
    await store.recordEvent({
      organizationId: f.org,
      attemptId: initial.attemptId,
      eventKey: 'failure',
      state: 'FAILED',
      occurredAt: new Date(),
    });
    const results = await Promise.allSettled([
      store.accept(redial),
      store.accept({ ...redial, idempotencyKey: 'redial-race' }),
    ]);
    const success = results.find((result) => result.status === 'fulfilled');
    expect(success?.status === 'fulfilled' && success.value.attemptNumber).toBe(2);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    await expect(store.accept({ ...redial, idempotencyKey: 'stale' })).rejects.toMatchObject({
      code: 'invalid_redial',
    });
    expect(await db.callAttempt.count({ where: { organizationId: f.org } })).toBe(2);
  });

  it('retains duplicates and conflicts append-only without rewriting a terminal state', async () => {
    const f = await fixture(),
      call = await store.accept(f.input);
    const base = {
      organizationId: f.org,
      attemptId: call.attemptId,
      occurredAt: new Date('2026-10-21T12:00:00Z'),
    };
    expect(
      (await store.recordEvent({ ...base, eventKey: 'dial', state: 'DIALING' })).disposition,
    ).toBe('APPLIED');
    const end = {
      ...base,
      eventKey: 'end',
      state: 'FAILED' as const,
      providerUsage: { connectedSeconds: 0 },
    };
    expect((await store.recordEvent(end)).disposition).toBe('APPLIED');
    expect((await store.recordEvent(end)).disposition).toBe('DUPLICATE');
    const conflict = await store.recordEvent({ ...end, state: 'COMPLETED' });
    expect(conflict).toMatchObject({
      disposition: 'CONFLICT',
      state: 'FAILED',
      diagnostic: { code: 'call_event_conflict' },
    });
    expect(JSON.stringify(conflict)).not.toContain('+256');
    expect((await store.recordEvent(end)).disposition).toBe('DUPLICATE');
    expect(
      (
        await store.recordEvent({
          ...end,
          eventKey: 'usage-correction',
          providerUsage: { connectedSeconds: 1 },
        })
      ).disposition,
    ).toBe('CONFLICT');
    expect(
      (await store.recordEvent({ ...base, eventKey: 'late', state: 'RINGING' })).disposition,
    ).toBe('CONFLICT');
    const events = await db.callEvent.findMany({ where: { organizationId: f.org } });
    expect(events).toHaveLength(7);
    const first = events[0];
    if (!first) throw new Error('Missing event evidence');
    await expect(
      db.callEvent.update({
        where: { organizationId_id: { organizationId: f.org, id: first.id } },
        data: { disposition: 'DUPLICATE' },
      }),
    ).rejects.toThrow();
    await expect(db.callEvent.deleteMany({ where: { organizationId: f.org } })).rejects.toThrow();
    await expect(
      db.callAttempt.update({
        where: { organizationId_id: { organizationId: f.org, id: call.attemptId } },
        data: { state: 'DIALING' },
      }),
    ).rejects.toThrow();
    await expect(
      db.callOperation.deleteMany({ where: { organizationId: f.org } }),
    ).rejects.toThrow();
    expect(await db.walletEntry.count({ where: { organizationId: f.org } })).toBe(0);
  });

  it('records illegal transitions and atomically rolls back state if event insertion fails', async () => {
    const f = await fixture(),
      call = await store.accept(f.input);
    const input = {
      organizationId: f.org,
      attemptId: call.attemptId,
      occurredAt: new Date(),
      eventKey: 'event',
      state: 'COMPLETED' as const,
    };
    expect((await store.recordEvent(input)).disposition).toBe('ILLEGAL');
    const failing: CallDatabase = {
      $queryRaw: db.$queryRaw.bind(db),
      $executeRaw: db.$executeRaw.bind(db),
      $transaction: (body) =>
        db.$transaction((tx) =>
          body({
            $queryRaw: tx.$queryRaw.bind(tx),
            $executeRaw: async (sql, ...values) => {
              if (sql.join('').includes('INSERT INTO call_events'))
                throw new Error('event write failure');
              return tx.$executeRaw(sql, ...values);
            },
          }),
        ),
    };
    await expect(
      new CallPersistence(failing).recordEvent({ ...input, state: 'DIALING', eventKey: 'dial' }),
    ).rejects.toThrow('event write failure');
    expect(
      (await db.callAttempt.findFirstOrThrow({ where: { organizationId: f.org } })).state,
    ).toBe('QUEUED');
    expect(await db.callEvent.count({ where: { organizationId: f.org } })).toBe(1);
  });

  it('database rejects invalid E.164 and direct duplicate or forged attempts', async () => {
    const f = await fixture(),
      call = await store.accept(f.input);
    await expect(
      db.contact.create({ data: { organizationId: f.org, destination: 'invalid' } }),
    ).rejects.toThrow();
    const row = await db.callAttempt.findFirstOrThrow({ where: { organizationId: f.org } });
    await expect(db.callAttempt.create({ data: { ...row, id: randomUUID() } })).rejects.toThrow();
    await expect(
      db.callAttempt.create({
        data: {
          ...row,
          id: randomUUID(),
          attemptNumber: 2,
          previousAttemptId: call.attemptId,
          redialReason: 'Forged active redial',
        },
      }),
    ).rejects.toThrow();
  });

  it('serializes concurrent events and replays the original acceptance after state advances', async () => {
    const f = await fixture(),
      call = await store.accept(f.input);
    const event = {
      organizationId: f.org,
      attemptId: call.attemptId,
      eventKey: 'concurrent',
      state: 'DIALING' as const,
      occurredAt: new Date(),
    };
    const results = await Promise.all(Array.from({ length: 5 }, () => store.recordEvent(event)));
    expect(results.filter((result) => result.disposition === 'APPLIED')).toHaveLength(1);
    expect(results.filter((result) => result.disposition === 'DUPLICATE')).toHaveLength(4);
    expect(await db.callEvent.count({ where: { organizationId: f.org } })).toBe(5);
    expect(await store.accept(f.input)).toEqual(call);
  });

  it('rejects acceptance for a suspended tenant or emergency-stopped campaign', async () => {
    const f = await fixture();
    await db.organization.update({ where: { id: f.org }, data: { suspendedAt: new Date() } });
    await expect(store.accept(f.input)).rejects.toMatchObject({ code: 'invalid_request' });
    await db.organization.update({ where: { id: f.org }, data: { suspendedAt: null } });
    await db.campaign.update({
      where: { organizationId_id: { organizationId: f.org, id: f.campaign } },
      data: { status: 'ACTIVE' },
    });
    await db.campaign.update({
      where: { organizationId_id: { organizationId: f.org, id: f.campaign } },
      data: { status: 'COMPLETED', emergencyStoppedAt: new Date() },
    });
    await expect(store.accept(f.input)).rejects.toMatchObject({ code: 'invalid_request' });
    expect(await db.callAttempt.count({ where: { organizationId: f.org } })).toBe(0);
  });
});
