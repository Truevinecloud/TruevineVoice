// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ContactsView } from './ContactsView';

const contact = {
  id: 'contact-1',
  phone: '+256772000001',
  name: 'Synthetic Ada',
  email: 'ada@example.invalid',
  voiceConsent: 'NOT_RECORDED',
  voiceConsentAt: null,
  suppressed: false,
  suppressedAt: null,
  createdAt: '2026-10-24T00:00:00Z',
  updatedAt: '2026-10-24T00:00:00Z',
};
let root: Root;
let host: HTMLDivElement;
let fetchMock: ReturnType<typeof vi.fn>;

function reply(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}
function button(label: string): HTMLButtonElement {
  const element = [...host.querySelectorAll('button')].find((entry) => entry.textContent === label);
  if (!element) throw new Error(`Missing button: ${label}`);
  return element;
}
async function click(label: string) {
  await act(async () => {
    button(label).click();
  });
}
async function fill(id: string, value: string) {
  await act(async () => {
    const input = host.querySelector<HTMLInputElement>(`#${id}`)!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function submit(id: string) {
  await act(async () => {
    host.querySelector(id)!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
}
async function mount(canCreate = true, canUpdate = true) {
  await act(async () => {
    root.render(
      <ContactsView
        organizationId="org-a"
        organizationName="Synthetic Tenant"
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
  fetchMock = vi.fn().mockImplementation(async () => reply({ items: [contact], nextCursor: null }));
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  host.remove();
  vi.unstubAllGlobals();
});

describe('Contacts interactive integration through the same-origin API client', () => {
  it('saves a corrected phone and renders the normalized server result', async () => {
    await mount();
    await click('View Contact');
    await click('Edit Contact');
    await fill('contact-phone', '0772 000 002');
    fetchMock.mockResolvedValueOnce(reply({ ...contact, phone: '+256772000002' }));
    await submit('.contact-editor form');
    expect(JSON.parse(fetchMock.mock.lastCall![1].body)).toMatchObject({ phone: '0772 000 002' });
    expect(fetchMock.mock.lastCall![1].method).toBe('PATCH');
    expect(host.querySelector('.contact-editor')!.textContent).toContain('+256772000002');
    expect(host.textContent).toContain('Contact saved.');
  });

  it.each([
    ['invalid_contact', 400, 'Enter a valid international number or Uganda-local phone number.'],
    ['contact_exists', 409, 'A contact with this phone number already exists in the organization.'],
    [
      'contact_phone_change_restricted',
      409,
      'Phone cannot be changed because this contact has campaign history.',
    ],
    [
      'contact_update_conflict',
      409,
      'The contact changed concurrently. Refresh contacts and try again.',
    ],
  ])('shows %s without changing the saved contact', async (code, status, message) => {
    await mount();
    await click('View Contact');
    await click('Edit Contact');
    await fill('contact-phone', '0772000002');
    fetchMock.mockResolvedValueOnce(reply({ error: { code, message } }, status));
    await submit('.contact-editor form');
    expect(host.querySelector('[role="alert"]')!.textContent).toContain(message);
    expect(host.querySelector<HTMLInputElement>('#contact-phone')!.value).toBe('0772000002');
    expect(host.querySelector('.contacts-list')!.textContent).toContain(contact.phone);
    expect(host.textContent).not.toContain('Contact saved.');
  });

  it.each([{ suppressed: true }, { voiceConsent: 'RECORDED' }])(
    'keeps the phone disabled for known restricted state %j but permits name editing',
    async (state) => {
      fetchMock.mockResolvedValueOnce(
        reply({ items: [{ ...contact, ...state }], nextCursor: null }),
      );
      await mount();
      await click('View Contact');
      await click('Edit Contact');
      expect(host.querySelector<HTMLInputElement>('#contact-phone')!.disabled).toBe(true);
      expect(host.textContent).toContain('Consent does not transfer');
      await fill('contact-name', 'Corrected name');
      fetchMock.mockResolvedValueOnce(reply({ ...contact, ...state, name: 'Corrected name' }));
      await submit('.contact-editor form');
      expect(JSON.parse(fetchMock.mock.lastCall![1].body)).toEqual({
        name: 'Corrected name',
        email: contact.email,
      });
      expect(host.textContent).toContain('Contact saved.');
    },
  );
  it('submits blank optional fields as text accepted by the create API', async () => {
    await mount();
    await click('Add Contact');
    await fill('contact-phone', '0772 000 001');
    fetchMock.mockResolvedValueOnce(reply(contact, 201));
    await submit('.contact-editor form');
    expect(JSON.parse(fetchMock.mock.lastCall![1].body)).toEqual({
      phone: '0772 000 001',
      name: '',
      email: '',
    });
    expect(host.textContent).toContain('Contact added.');
  });
  it('lists, creates with CSRF, shows server E.164, views, edits and deletes an eligible synthetic contact', async () => {
    await mount();
    expect(host.textContent).toContain(contact.phone);
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/organizations/org-a/contacts?limit=50');
    await click('Add Contact');
    await fill('contact-phone', '0772 000 002');
    await fill('contact-name', 'Synthetic Bea');
    await fill('contact-email', 'bea@example.invalid');
    const created = {
      ...contact,
      id: 'contact-2',
      phone: '+256772000002',
      name: 'Synthetic Bea',
      email: 'bea@example.invalid',
    };
    fetchMock.mockResolvedValueOnce(reply(created, 201));
    await submit('.contact-editor form');
    expect(fetchMock.mock.lastCall).toEqual([
      '/api/organizations/org-a/contacts',
      expect.objectContaining({
        method: 'POST',
        credentials: 'same-origin',
        headers: expect.objectContaining({ 'x-truevine-csrf': 'synthetic-csrf' }),
        body: JSON.stringify({
          name: 'Synthetic Bea',
          email: 'bea@example.invalid',
          phone: '0772 000 002',
        }),
      }),
    ]);
    expect(host.textContent).toContain('Contact added.');
    expect(host.querySelector('.contact-editor')!.textContent).toContain('+256772000002');
    await click('Edit Contact');
    expect(host.querySelector<HTMLInputElement>('#contact-phone')!.disabled).toBe(false);
    await fill('contact-name', 'Synthetic Bea Updated');
    fetchMock.mockResolvedValueOnce(reply({ ...created, name: 'Synthetic Bea Updated' }));
    await submit('.contact-editor form');
    expect(JSON.parse(fetchMock.mock.lastCall![1].body)).toEqual({
      name: 'Synthetic Bea Updated',
      email: 'bea@example.invalid',
      phone: created.phone,
    });
    expect(fetchMock.mock.lastCall![1].method).toBe('PATCH');
    expect(host.textContent).toContain('Contact saved.');
    await click('Delete Contact');
    expect(host.textContent).toContain('This cannot be undone');
    fetchMock.mockResolvedValueOnce(reply({ deleted: true }));
    await submit('.contact-editor form');
    expect(fetchMock.mock.lastCall![1].method).toBe('DELETE');
    expect(host.textContent).toContain('Contact deleted.');
    expect(host.textContent).not.toContain('Synthetic Bea Updated');
    await click('View Contact');
    expect(host.querySelector('.contact-editor')!.textContent).toContain('Synthetic Ada');
  });

  it('searches beyond the first page and renders no matches separately from an empty organization', async () => {
    await mount();
    await fill('contact-search', 'bea');
    fetchMock
      .mockResolvedValueOnce(reply({ items: [contact], nextCursor: 'contact-1' }))
      .mockResolvedValueOnce(
        reply({
          items: [{ ...contact, id: 'contact-2', name: 'Synthetic Bea' }],
          nextCursor: null,
        }),
      );
    await submit('form');
    expect(host.textContent).toContain('Synthetic Bea');
    expect(host.textContent).not.toContain('Synthetic Ada');
    expect(fetchMock.mock.lastCall![0]).toContain('cursor=contact-1');
    await fill('contact-search', 'missing');
    await submit('form');
    expect(host.textContent).toContain('No contacts match your search');
    fetchMock.mockResolvedValueOnce(reply({ items: [], nextCursor: null }));
    await click('Refresh / clear');
    expect(host.textContent).toContain('No contacts yet');
  });

  it('shows loading and allows retry after a list/network error', async () => {
    let reject!: (value: unknown) => void;
    fetchMock.mockReturnValueOnce(
      new Promise((_resolve, fail) => {
        reject = fail;
      }),
    );
    await mount();
    expect(host.textContent).toContain('Loading contacts');
    await act(async () => {
      reject(new Error('offline'));
    });
    expect(host.querySelector('[role="alert"]')).not.toBeNull();
    await click('Refresh / clear');
    expect(host.textContent).toContain('Synthetic Ada');
  });

  it.each([
    [400, 'invalid_contact', 'Phone number is invalid.'],
    [409, 'contact_exists', 'A contact with this phone number already exists.'],
    [403, 'permission_denied', 'You do not have permission.'],
    [401, 'unauthenticated', 'Session ended.'],
    [403, 'terms_acceptance_required', 'Accept current terms.'],
    [500, 'unexpected_error', 'Please try again.'],
  ])('retains form input on API failure %s %s', async (status, code, message) => {
    await mount();
    await click('Add Contact');
    await fill('contact-phone', 'invalid');
    fetchMock.mockResolvedValueOnce(reply({ error: { code, message } }, status));
    await submit('.contact-editor form');
    expect(host.querySelector('[role="alert"]')!.textContent).toContain(message);
    expect(host.querySelector<HTMLInputElement>('#contact-phone')!.value).toBe('invalid');
    expect(host.textContent).not.toContain('Contact added.');
    if (status === 401) expect(host.querySelector('a[href^="/sign-in"]')).not.toBeNull();
    if (code === 'terms_acceptance_required')
      expect(host.querySelector('a[href="/accept-terms"]')).not.toBeNull();
  });

  it('retains campaign-referenced contacts when the backend refuses deletion', async () => {
    await mount();
    await click('View Contact');
    await click('Delete Contact');
    fetchMock.mockResolvedValueOnce(
      reply(
        {
          error: {
            code: 'contact_has_campaign_history',
            message: 'Contacts referenced by campaign history cannot be deleted.',
          },
        },
        409,
      ),
    );
    await submit('.contact-editor form');
    expect(host.querySelector('[role="alert"]')!.textContent).toContain('cannot be deleted');
    expect(host.textContent).toContain('Synthetic Ada');
  });

  it('disables suppressed deletion and hides writes without their specific permissions', async () => {
    fetchMock.mockResolvedValueOnce(
      reply({ items: [{ ...contact, suppressed: true }], nextCursor: null }),
    );
    await mount();
    await click('View Contact');
    expect(button('Delete Contact').disabled).toBe(true);
    await act(async () => {
      root.render(
        <ContactsView
          organizationId="org-a"
          organizationName="Synthetic Tenant"
          canCreate={false}
          canUpdate={false}
        />,
      );
    });
    expect(host.textContent).not.toContain('Add Contact');
    expect(host.textContent).not.toContain('Edit Contact');
    expect(host.textContent).not.toContain('Delete Contact');
  });
});
