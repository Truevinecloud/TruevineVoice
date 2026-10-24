// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GroupsView } from './GroupsView';
import type { ContactGroup } from '../../../lib/contact-groups';
import type { Contact } from '../../../lib/contacts';

const initial = {
  id: 'group-1',
  name: 'Customers',
  memberCount: 0,
  createdAt: '2026-10-24T00:00:00Z',
};
const contact: Contact = {
  id: 'contact-1',
  name: 'Synthetic Ada',
  phone: '+12025550101',
  email: null,
  voiceConsent: 'NOT_RECORDED',
  voiceConsentAt: null,
  suppressed: false,
  suppressedAt: null,
  createdAt: initial.createdAt,
  updatedAt: initial.createdAt,
};
let root: Root;
let host: HTMLDivElement;
let fetchMock: ReturnType<typeof vi.fn>;
let groups: ContactGroup[];
let members: Contact[];
const base = '/api/organizations/org-a/contact-groups';
function reply(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}
function button(label: string) {
  const found = [...host.querySelectorAll('button')].find((entry) => entry.textContent === label);
  if (!found) throw new Error('Missing button ' + label);
  return found;
}
async function click(label: string) {
  await act(async () => {
    button(label).click();
  });
}
async function fill(id: string, value: string) {
  await act(async () => {
    const input = host.querySelector<HTMLInputElement>('#' + id)!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function submit(selector: string) {
  await act(async () => {
    host
      .querySelector(selector)!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
}
async function mount(canCreate = true, canUpdate = true) {
  await act(async () => {
    root.render(
      <GroupsView
        organizationId="org-a"
        organizationName="Synthetic QA tenant"
        canCreate={canCreate}
        canUpdate={canUpdate}
      />,
    );
  });
}

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  document.cookie = 'tv_csrf=synthetic-csrf; path=/';
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  groups = [{ ...initial }];
  members = [];
  fetchMock = vi
    .fn()
    .mockImplementation(async (path: string, options: { method: string; body?: string }) => {
      const url = new URL(path, 'https://test.invalid');
      const method = options.method;
      if (url.pathname === base && method === 'GET') return reply(groups);
      if (url.pathname === base && method === 'POST') {
        const added = { ...initial, id: 'group-2', name: JSON.parse(options.body!).name };
        groups.push(added);
        return reply(added, 201);
      }
      if (url.pathname === base + '/group-1' || url.pathname === base + '/group-2') {
        const found = groups.find((group) => url.pathname.endsWith('/' + group.id))!;
        if (method === 'PATCH') {
          groups = groups.map((group) =>
            group.id === found.id ? { ...group, name: JSON.parse(options.body!).name } : group,
          );
          return reply(groups.find((group) => group.id === found.id));
        }
        if (method === 'DELETE') {
          groups = groups.filter((group) => group.id !== found.id);
          return reply({ deleted: true });
        }
        return reply(found);
      }
      if (url.pathname.endsWith('/contacts/contact-1')) {
        members = method === 'POST' ? [contact] : [];
        groups = groups.map((group, index) =>
          index === 0 ? { ...group, memberCount: members.length } : group,
        );
        return reply({ member: method === 'POST', changed: true }, method === 'POST' ? 201 : 200);
      }
      if (url.pathname.includes('/contact-groups/') && url.pathname.endsWith('/contacts'))
        return reply({ items: members, nextCursor: null });
      if (url.pathname === '/api/organizations/org-a/contacts')
        return reply({ items: [contact], nextCursor: null });
      throw new Error('Unexpected request ' + method + ' ' + path);
    });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe('Contact groups interactive API integration', () => {
  it('creates, views, renames and deletes only the group after explicit confirmation', async () => {
    await mount();
    expect(host.textContent).toContain('Customers');
    await click('Create group');
    await fill('group-name', 'New segment');
    await submit('[aria-label="Group editor"] form');
    expect(host.textContent).toContain('Group created.');
    expect(fetchMock.mock.calls).toContainEqual([
      base,
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ name: 'New segment' }),
        headers: expect.objectContaining({ 'x-truevine-csrf': 'synthetic-csrf' }),
      }),
    ]);
    await click('Rename group');
    await fill('group-name', 'Renamed segment');
    await submit('[aria-label="Group editor"] form');
    expect(host.textContent).toContain('Group renamed.');
    expect(host.querySelector('[aria-label="Group details"]')!.textContent).toContain(
      'Renamed segment',
    );
    await click('Delete group');
    expect(fetchMock.mock.calls.some(([, options]) => options.method === 'DELETE')).toBe(false);
    expect(host.textContent).toContain('Contacts and campaign history will be kept');
    await click('Cancel');
    expect(host.textContent).not.toContain('Confirm group deletion');
    await click('Delete group');
    await submit('[aria-label="Group editor"] form');
    expect(host.textContent).toContain('Group deleted. Contacts were kept.');
    expect(
      fetchMock.mock.calls
        .filter(([, options]) => options.method === 'DELETE')
        .map(([path]) => path),
    ).toEqual([base + '/group-2']);
  });

  it('finds existing contacts, adds and removes membership without deleting the contact', async () => {
    await mount();
    await click('View group');
    expect(host.textContent).toContain('This group has no contacts.');
    await fill('group-contact-search', 'Ada');
    await submit('[aria-label="Group details"] form');
    expect(host.textContent).toContain('Synthetic Ada');
    await click('Add to group');
    expect(host.textContent).toContain('Contact added to group.');
    expect(button('Add to group').disabled).toBe(true);
    expect(host.querySelector('[aria-label="Group details"]')!.textContent).toContain('1 contacts');
    await click('Remove from group');
    expect(host.textContent).toContain('Contact removed from group. The contact was kept.');
    expect(button('Add to group').disabled).toBe(false);
    expect(
      fetchMock.mock.calls
        .filter(([, options]) => options.method === 'DELETE')
        .map(([path]) => path),
    ).toEqual([base + '/group-1/contacts/contact-1']);
  });

  it.each([
    ['contact_group_exists', 409, 'A group with this name already exists.'],
    ['invalid_contact', 400, 'Group name must be 1 to 120 characters.'],
    ['permission_denied', 403, 'Permission denied.'],
    ['contact_group_not_found', 404, 'Group not found.'],
    ['server_error', 500, 'Unable to save group.'],
    ['unauthenticated', 401, 'Sign in again.'],
    ['terms_acceptance_required', 403, 'Review terms.'],
  ])('shows %s and retains the submitted group editor', async (code, status, message) => {
    await mount();
    await click('View group');
    await click('Rename group');
    await fill('group-name', 'Correction');
    fetchMock.mockResolvedValueOnce(reply({ error: { code, message } }, status));
    await submit('[aria-label="Group editor"] form');
    expect(host.querySelector('[role="alert"]')!.textContent).toContain(message);
    expect(host.querySelector<HTMLInputElement>('#group-name')!.value).toBe('Correction');
    expect(host.textContent).not.toContain('Group renamed.');
    if (status === 401) expect(host.querySelector('a[href^="/sign-in"]')).not.toBeNull();
    if (code === 'terms_acceptance_required')
      expect(host.querySelector('a[href="/accept-terms"]')).not.toBeNull();
  });

  it('keeps the group visible when deletion is refused', async () => {
    await mount();
    await click('View group');
    await click('Delete group');
    fetchMock.mockResolvedValueOnce(
      reply({ error: { code: 'permission_denied', message: 'Permission denied.' } }, 403),
    );
    await submit('[aria-label="Group editor"] form');
    expect(host.querySelector('[role="alert"]')!.textContent).toContain('Permission denied');
    expect(host.querySelector('.contacts-list')!.textContent).toContain('Customers');
  });

  it('hides each write according to its permission while retaining group viewing', async () => {
    await mount(false, false);
    expect(host.textContent).not.toContain('Create group');
    await click('View group');
    expect(host.textContent).not.toContain('Rename group');
    expect(host.textContent).not.toContain('Delete group');
    expect(host.textContent).not.toContain('Add existing contacts');
    expect(fetchMock.mock.calls.every(([, options]) => options.method === 'GET')).toBe(true);
  });

  it('can close group detail and refresh after a concurrently deleted selection', async () => {
    await mount();
    await click('View group');
    groups = [];
    await click('Close group');
    await click('Refresh groups');
    expect(host.querySelector('[aria-label="Group details"]')).toBeNull();
    expect(host.textContent).toContain('No groups yet.');
  });

  it('shows empty groups, loading, load failures and retry', async () => {
    let release!: (value: Response) => void;
    fetchMock.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
    );
    await mount();
    expect(host.textContent).toContain('Loading or saving groups');
    await act(async () => {
      release(reply({ error: { code: 'server_error', message: 'Unavailable' } }, 500));
    });
    expect(host.querySelector('[role="alert"]')!.textContent).toContain('Unavailable');
    groups = [];
    await click('Refresh groups');
    expect(host.textContent).toContain('No groups yet.');
  });

  it('loads further member pages within the selected organization and group', async () => {
    await mount();
    fetchMock
      .mockResolvedValueOnce(reply([initial]))
      .mockResolvedValueOnce(reply(initial))
      .mockResolvedValueOnce(reply({ items: [contact], nextCursor: 'contact-1' }));
    await click('View group');
    fetchMock.mockResolvedValueOnce(
      reply({ items: [{ ...contact, id: 'contact-2', name: 'Synthetic Bea' }], nextCursor: null }),
    );
    await click('Load more group contacts');
    expect(fetchMock.mock.lastCall![0]).toBe(base + '/group-1/contacts?limit=50&cursor=contact-1');
    expect(host.textContent).toContain('Synthetic Ada');
    expect(host.textContent).toContain('Synthetic Bea');
  });
});
