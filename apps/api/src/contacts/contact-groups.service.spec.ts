import { describe, expect, it, vi } from 'vitest';
import { ContactsService } from './contacts.service.js';
import { ContactGroupConflictError, type ContactStore } from './contact.store.js';

const id = '10000000-0000-4000-8000-000000000001';
const contactId = '20000000-0000-4000-8000-000000000002';
const group = {
  organizationId: 'org-a',
  id,
  name: 'Customers',
  normalizedName: 'customers',
  createdAt: new Date('2026-10-24T00:00:00Z'),
  memberCount: 2,
};
function service(store: Partial<ContactStore>) {
  return new ContactsService(store as ContactStore);
}

describe('Contact group service contracts', () => {
  it('normalizes names consistently for create and rename without trusting client scope', async () => {
    const createGroup = vi.fn().mockResolvedValue(group);
    const updateGroup = vi.fn().mockResolvedValue(group);
    const contacts = service({ createGroup, updateGroup });
    await contacts.createGroup('org-a', 'actor', { name: '  Loyal   Customers  ' });
    expect(createGroup).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: 'org-a',
        actorUserId: 'actor',
        name: 'Loyal Customers',
        normalizedName: 'loyal customers',
      }),
    );
    await contacts.updateGroup('org-a', 'actor', id, { name: ' Customers ' });
    expect(updateGroup).toHaveBeenCalledWith({
      organizationId: 'org-a',
      actorUserId: 'actor',
      groupId: id,
      name: 'Customers',
      normalizedName: 'customers',
    });
    await expect(
      contacts.createGroup('org-a', 'actor', { name: 'X', organizationId: 'org-b' }),
    ).rejects.toMatchObject({ status: 400 });
  });
  it.each([
    {},
    null,
    [],
    { name: '' },
    { name: ' '.repeat(4) },
    { name: 'a'.repeat(121) },
    { name: 'bad\u0000name' },
    { name: 123 },
    { name: 'X', members: [contactId] },
    { name: 'X', organizationId: 'org-b' },
  ])('rejects invalid group writes %j', async (body) => {
    const updateGroup = vi.fn();
    const createGroup = vi.fn();
    const contacts = service({ updateGroup, createGroup });
    await expect(contacts.updateGroup('org-a', 'actor', id, body)).rejects.toMatchObject({
      status: 400,
    });
    await expect(contacts.createGroup('org-a', 'actor', body)).rejects.toMatchObject({
      status: 400,
    });
    expect(updateGroup).not.toHaveBeenCalled();
    expect(createGroup).not.toHaveBeenCalled();
  });
  it('reports normalized duplicate names consistently', async () => {
    const contacts = service({
      createGroup: vi.fn().mockRejectedValue(new Error('contact_group_conflict')),
      updateGroup: vi.fn().mockRejectedValue(new ContactGroupConflictError()),
    });
    await expect(
      contacts.createGroup('org-a', 'actor', { name: 'Customers' }),
    ).rejects.toMatchObject({ status: 409, response: { error: { code: 'contact_group_exists' } } });
    await expect(
      contacts.updateGroup('org-a', 'actor', id, { name: 'Customers' }),
    ).rejects.toMatchObject({ status: 409, response: { error: { code: 'contact_group_exists' } } });
  });
  it('returns scoped group detail and paginated contacts using only the requested group', async () => {
    const findGroup = vi.fn().mockResolvedValue(group);
    const listContacts = vi.fn().mockResolvedValue([]);
    const contacts = service({ findGroup, listContacts });
    expect(await contacts.getGroup('org-a', id)).toMatchObject({ id, memberCount: 2 });
    expect(await contacts.groupContacts('org-a', id, { limit: '25', cursor: contactId })).toEqual({
      items: [],
      nextCursor: null,
    });
    expect(listContacts).toHaveBeenCalledWith({
      organizationId: 'org-a',
      groupId: id,
      limit: 25,
      cursor: contactId,
    });
    await expect(contacts.groupContacts('org-a', id, { limit: '101' })).rejects.toMatchObject({
      status: 400,
    });
  });
  it('reports missing and foreign groups without querying contacts', async () => {
    const listContacts = vi.fn();
    const contacts = service({
      findGroup: vi.fn().mockResolvedValue(undefined),
      listContacts,
      updateGroup: vi.fn().mockResolvedValue(undefined),
      deleteGroup: vi.fn().mockResolvedValue(false),
    });
    await expect(contacts.getGroup('org-b', id)).rejects.toMatchObject({ status: 404 });
    await expect(contacts.groupContacts('org-b', id, {})).rejects.toMatchObject({ status: 404 });
    await expect(
      contacts.updateGroup('org-b', 'actor', id, { name: 'Foreign' }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(contacts.deleteGroup('org-b', 'actor', id)).rejects.toMatchObject({ status: 404 });
    expect(listContacts).not.toHaveBeenCalled();
  });
  it.each([true, false])(
    'scopes membership changes and preserves replay result for member=%s',
    async (member) => {
      const setGroupMembership = vi.fn().mockResolvedValue({ member, changed: false });
      const contacts = service({ setGroupMembership });
      expect(await contacts.setGroupMembership('org-a', 'actor', id, contactId, member)).toEqual({
        member,
        changed: false,
      });
      expect(setGroupMembership).toHaveBeenCalledWith({
        organizationId: 'org-a',
        actorUserId: 'actor',
        groupId: id,
        contactId,
        member,
      });
      setGroupMembership.mockResolvedValue(undefined);
      await expect(
        contacts.setGroupMembership('org-b', 'actor', id, contactId, member),
      ).rejects.toMatchObject({
        status: 404,
        response: { error: { code: 'contact_group_member_not_found' } },
      });
    },
  );
  it('validates resource identifiers before any store access', async () => {
    const setGroupMembership = vi.fn();
    const findGroup = vi.fn();
    const contacts = service({ setGroupMembership, findGroup });
    await expect(contacts.getGroup('org-a', 'not-an-id')).rejects.toMatchObject({ status: 400 });
    await expect(
      contacts.setGroupMembership('org-a', 'actor', id, 'not-an-id', true),
    ).rejects.toMatchObject({ status: 400 });
    expect(setGroupMembership).not.toHaveBeenCalled();
    expect(findGroup).not.toHaveBeenCalled();
  });
});
