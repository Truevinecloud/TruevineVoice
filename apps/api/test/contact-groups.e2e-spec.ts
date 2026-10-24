import { randomUUID } from 'node:crypto';
import { createDatabaseClient, type PrismaClient } from '@truevine/database';
import { loadEnvFiles, requireEnv } from '@truevine/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  assertConnectedToDisposableDatabase,
  assertDisposableDatabase,
} from './disposable-database.js';
import { PrismaContactStore } from '../src/contacts/prisma-contact.store.js';
import { ContactsService } from '../src/contacts/contacts.service.js';

describe('W2-02 Increment 2 PostgreSQL contact groups', () => {
  let database: PrismaClient;
  let store: PrismaContactStore;
  let service: ContactsService;
  const organizationId = randomUUID();
  const otherOrganizationId = randomUUID();
  const actorUserId = randomUUID();
  const run = randomUUID().replaceAll('-', '');
  beforeAll(async () => {
    loadEnvFiles();
    const url = requireEnv('DATABASE_URL');
    const expected = assertDisposableDatabase(url, process.env['NODE_ENV']);
    database = createDatabaseClient(url);
    await database.$connect();
    const rows = await database.$queryRaw<{ name: string }[]>`SELECT current_database() AS name`;
    await assertConnectedToDisposableDatabase(async () => rows[0]?.name, expected);
    store = new PrismaContactStore(database);
    service = new ContactsService(store);
    await database.user.create({
      data: {
        id: actorUserId,
        email: `groups-${run}@example.test`,
        passwordHash: 'test-only-not-used',
      },
    });
    await database.$transaction(async (tx) => {
      await tx.organization.createMany({
        data: [
          { id: organizationId, slug: 'groups-' + run, name: 'Groups disposable QA' },
          { id: otherOrganizationId, slug: 'groups-other-' + run, name: 'Other disposable QA' },
        ],
      });
      await tx.membership.createMany({
        data: [organizationId, otherOrganizationId].map((id) => ({
          organizationId: id,
          userId: actorUserId,
          role: 'OWNER' as const,
        })),
      });
    });
  });
  afterAll(async () => {
    await database?.$disconnect();
  });
  async function group(name: string, tenant = organizationId) {
    return service.createGroup(tenant, actorUserId, { name });
  }
  async function contact(phone: string, tenant = organizationId) {
    return service.createContact(tenant, actorUserId, { phone, name: 'Synthetic group contact' });
  }
  function key(id: string, tenant = organizationId) {
    return { organizationId_id: { organizationId: tenant, id } };
  }

  it('normalizes group names, scopes duplicates and audits create/rename without names or contact PII', async () => {
    const original = await group('  Loyal   Customers ');
    expect(original).toMatchObject({ name: 'Loyal Customers', memberCount: 0 });
    await expect(group('LOYAL customers')).rejects.toMatchObject({ status: 409 });
    await expect(group('LOYAL customers', otherOrganizationId)).resolves.toMatchObject({
      memberCount: 0,
    });
    const second = await group('Rename target');
    await expect(
      service.updateGroup(organizationId, actorUserId, second.id, { name: 'loyal customers' }),
    ).rejects.toMatchObject({ status: 409 });
    expect(await service.getGroup(organizationId, second.id)).toMatchObject({
      name: 'Rename target',
    });
    expect(
      await service.updateGroup(organizationId, actorUserId, original.id, {
        name: 'Renamed group',
      }),
    ).toMatchObject({ id: original.id, name: 'Renamed group' });
    const events = await database.securityAuditEvent.findMany({
      where: { organizationId, targetId: original.id },
      orderBy: { occurredAt: 'asc' },
    });
    expect(events.map((e) => e.action)).toEqual(['contact_group.created', 'contact_group.updated']);
    expect(events[0]!.metadata).toEqual({});
    expect(events[1]!.metadata).toEqual({ fields: ['name'] });
  });

  it('supports multiple groups, idempotent membership changes and scoped member pagination', async () => {
    const first = await group('Membership first');
    const second = await group('Membership second');
    const a = await contact('+12025550101');
    const b = await contact('+12025550102');
    for (const item of [a, b])
      expect(
        await service.setGroupMembership(organizationId, actorUserId, first.id, item.id, true),
      ).toEqual({ member: true, changed: true });
    await service.setGroupMembership(organizationId, actorUserId, second.id, a.id, true);
    expect(
      await service.setGroupMembership(organizationId, actorUserId, first.id, a.id, true),
    ).toEqual({ member: true, changed: false });
    expect(await service.getGroup(organizationId, first.id)).toMatchObject({ memberCount: 2 });
    const page1 = await service.groupContacts(organizationId, first.id, { limit: 1 });
    const page2 = await service.groupContacts(organizationId, first.id, {
      limit: 1,
      cursor: page1.nextCursor,
    });
    expect(new Set([page1.items[0]!.id, page2.items[0]!.id])).toEqual(new Set([a.id, b.id]));
    expect(
      (await service.groupContacts(organizationId, second.id, {})).items.map((c) => c.id),
    ).toEqual([a.id]);
    expect(
      await service.setGroupMembership(organizationId, actorUserId, first.id, a.id, false),
    ).toEqual({ member: false, changed: true });
    expect(
      await service.setGroupMembership(organizationId, actorUserId, first.id, a.id, false),
    ).toEqual({ member: false, changed: false });
    expect(
      (await service.groupContacts(organizationId, second.id, {})).items.map((c) => c.id),
    ).toEqual([a.id]);
    expect(await database.contact.findUnique({ where: key(a.id) })).not.toBeNull();
    const audit = await database.securityAuditEvent.findMany({
      where: {
        organizationId,
        targetId: first.id,
        action: { in: ['contact_group.member_added', 'contact_group.member_removed'] },
      },
    });
    expect(audit).toHaveLength(3);
    expect(
      audit.every((event) => Object.keys(event.metadata as object).join() === 'contactId'),
    ).toBe(true);
  });

  it('rejects foreign groups and contacts without disclosure, partial links or mutation audits', async () => {
    const local = await group('Tenant local');
    const foreign = await group('Tenant foreign', otherOrganizationId);
    const a = await contact('+12025550103');
    const b = await contact('+12025550104', otherOrganizationId);
    for (const member of [true, false]) {
      await expect(
        service.setGroupMembership(organizationId, actorUserId, foreign.id, a.id, member),
      ).rejects.toMatchObject({ status: 404 });
      await expect(
        service.setGroupMembership(organizationId, actorUserId, local.id, b.id, member),
      ).rejects.toMatchObject({ status: 404 });
    }
    await expect(service.getGroup(organizationId, foreign.id)).rejects.toMatchObject({
      status: 404,
    });
    await expect(service.groupContacts(organizationId, foreign.id, {})).rejects.toMatchObject({
      status: 404,
    });
    await expect(
      service.updateGroup(organizationId, actorUserId, foreign.id, { name: 'Forged rename' }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      service.deleteGroup(organizationId, actorUserId, foreign.id),
    ).rejects.toMatchObject({ status: 404 });
    expect(
      (await service.listGroups(organizationId)).some(
        (g) => (g as { id: string }).id === foreign.id,
      ),
    ).toBe(false);
    expect(
      await database.securityAuditEvent.count({
        where: {
          organizationId,
          targetId: { in: [local.id, foreign.id] },
          action: { not: 'contact_group.created' },
        },
      }),
    ).toBe(0);
    await expect(
      database.contactGroupMember.create({
        data: { organizationId, groupId: local.id, contactId: b.id },
      }),
    ).rejects.toMatchObject({ code: 'P2003' });
    await expect(
      database.contactGroupMember.create({
        data: { organizationId, groupId: foreign.id, contactId: a.id },
      }),
    ).rejects.toMatchObject({ code: 'P2003' });
  });

  it('group removal and deletion preserve contacts, consent, suppression and campaign snapshots', async () => {
    const original = await group('Delete only group');
    const item = await contact('+12025550105');
    await store.recordVoiceConsent({
      organizationId,
      actorUserId,
      contactId: item.id,
      consentedAt: new Date(Date.now() - 1000),
      source: 'test_form',
      purpose: 'voice_calling',
      evidenceReference: 'groups-test',
    });
    await store.suppressContact({
      organizationId,
      actorUserId,
      contactId: item.id,
      reason: 'user_opt_out',
    });
    const campaignId = randomUUID();
    await database.campaign.create({
      data: {
        organizationId,
        id: campaignId,
        name: 'Group snapshot regression',
        createdById: actorUserId,
      },
    });
    const recipient = await database.campaignRecipient.create({
      data: {
        organizationId,
        id: randomUUID(),
        campaignId,
        contactId: item.id,
        destination: item.phone,
      },
    });
    const before = await database.contact.findUniqueOrThrow({ where: key(item.id) });
    await service.setGroupMembership(organizationId, actorUserId, original.id, item.id, true);
    await service.setGroupMembership(organizationId, actorUserId, original.id, item.id, false);
    await service.setGroupMembership(organizationId, actorUserId, original.id, item.id, true);
    expect(await service.deleteGroup(organizationId, actorUserId, original.id)).toEqual({
      deleted: true,
    });
    expect(
      await database.contactGroupMember.count({ where: { organizationId, groupId: original.id } }),
    ).toBe(0);
    expect(await database.contact.findUniqueOrThrow({ where: key(item.id) })).toEqual(before);
    expect(
      await database.campaignRecipient.findUniqueOrThrow({ where: key(recipient.id) }),
    ).toEqual(recipient);
    expect(
      await database.securityAuditEvent.count({
        where: { organizationId, targetId: original.id, action: 'contact_group.deleted' },
      }),
    ).toBe(1);
  });

  it('serializes concurrent membership retries and duplicate group creation', async () => {
    const original = await group('Concurrent group');
    const item = await contact('+12025550106');
    const add = await Promise.all(
      [1, 2].map(() =>
        service.setGroupMembership(organizationId, actorUserId, original.id, item.id, true),
      ),
    );
    expect(add.filter((r) => r.changed)).toHaveLength(1);
    const remove = await Promise.all(
      [1, 2].map(() =>
        service.setGroupMembership(organizationId, actorUserId, original.id, item.id, false),
      ),
    );
    expect(remove.filter((r) => r.changed)).toHaveLength(1);
    const create = await Promise.allSettled([group('Concurrent name'), group('concurrent NAME')]);
    expect(create.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(create.filter((r) => r.status === 'rejected')).toHaveLength(1);
    expect(
      await database.securityAuditEvent.count({
        where: {
          organizationId,
          targetId: original.id,
          action: { in: ['contact_group.member_added', 'contact_group.member_removed'] },
        },
      }),
    ).toBe(2);
  });

  it('rechecks current permissions inside every group write transaction', async () => {
    const original = await group('Authorization group');
    const item = await contact('+12025550107');
    const userId = randomUUID();
    await database.user.create({
      data: { id: userId, email: `groups-role-${run}@example.test`, passwordHash: 'test-only' },
    });
    await database.membership.createMany({
      data: [
        { organizationId, userId, role: 'VIEWER' },
        { organizationId: otherOrganizationId, userId, role: 'ADMIN' },
      ],
    });
    for (const role of ['VIEWER', 'BILLING'] as const) {
      await database.membership.update({
        where: { organizationId_userId: { organizationId, userId } },
        data: { role },
      });
      for (const operation of [
        () => service.createGroup(organizationId, userId, { name: 'Forbidden' }),
        () => service.updateGroup(organizationId, userId, original.id, { name: 'Forbidden' }),
        () => service.deleteGroup(organizationId, userId, original.id),
        () => service.setGroupMembership(organizationId, userId, original.id, item.id, true),
        () => service.setGroupMembership(organizationId, userId, original.id, item.id, false),
      ])
        await expect(operation()).rejects.toMatchObject({ status: 403 });
    }
    for (const role of ['ADMIN', 'CAMPAIGN_MANAGER'] as const) {
      await database.membership.update({
        where: { organizationId_userId: { organizationId, userId } },
        data: { role },
      });
      const created = await service.createGroup(organizationId, userId, {
        name: 'Allowed ' + role,
      });
      await service.updateGroup(organizationId, userId, created.id, { name: 'Updated ' + role });
      await service.setGroupMembership(organizationId, userId, created.id, item.id, true);
      await service.setGroupMembership(organizationId, userId, created.id, item.id, false);
      await expect(service.deleteGroup(organizationId, userId, created.id)).resolves.toEqual({
        deleted: true,
      });
    }
  });

  it('rolls back every mutation when its required audit insert fails', async () => {
    const original = await group('Audit rollback group');
    const item = await contact('+12025550108');
    const broken = new ContactsService(
      new PrismaContactStore(
        database.$extends({
          query: {
            securityAuditEvent: {
              create() {
                throw new Error('audit unavailable');
              },
            },
          },
        }) as unknown as PrismaClient,
      ),
    );
    await expect(
      broken.createGroup(organizationId, actorUserId, { name: 'Rollback create' }),
    ).rejects.toThrow('audit unavailable');
    expect(
      await database.contactGroup.count({ where: { organizationId, name: 'Rollback create' } }),
    ).toBe(0);
    await expect(
      broken.updateGroup(organizationId, actorUserId, original.id, { name: 'Rollback rename' }),
    ).rejects.toThrow('audit unavailable');
    expect((await service.getGroup(organizationId, original.id)).name).toBe(original.name);
    await expect(
      broken.setGroupMembership(organizationId, actorUserId, original.id, item.id, true),
    ).rejects.toThrow('audit unavailable');
    expect(
      await database.contactGroupMember.count({ where: { organizationId, groupId: original.id } }),
    ).toBe(0);
    await service.setGroupMembership(organizationId, actorUserId, original.id, item.id, true);
    await expect(
      broken.setGroupMembership(organizationId, actorUserId, original.id, item.id, false),
    ).rejects.toThrow('audit unavailable');
    await expect(broken.deleteGroup(organizationId, actorUserId, original.id)).rejects.toThrow(
      'audit unavailable',
    );
    expect((await service.getGroup(organizationId, original.id)).memberCount).toBe(1);
  });
});
