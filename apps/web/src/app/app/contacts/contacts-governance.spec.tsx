// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Contact } from '../../../lib/contacts';
import { ContactGovernance } from './contact-governance';

const baseContact: Contact = {
  id: 'contact-1',
  phone: '+256772000001',
  name: 'Synthetic Ada',
  email: 'ada@example.invalid',
  voiceConsent: 'NOT_RECORDED',
  voiceConsentAt: null,
  suppressed: false,
  suppressedAt: null,
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-02T00:00:00.000Z',
};

let root: Root;
let host: HTMLDivElement;
let requests: Array<{ readonly url: string; readonly method: string; readonly body: unknown }>;
let reply: ((url: string) => Response | undefined) | undefined;
const onUpdated = vi.fn();

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function button(label: string): HTMLButtonElement {
  const element = [...host.querySelectorAll('button')].find(
    (entry) => entry.textContent?.trim() === label,
  );
  if (!element) throw new Error(`Missing button: ${label}`);
  return element;
}

function maybeButton(label: string): HTMLButtonElement | undefined {
  return [...host.querySelectorAll('button')].find(
    (entry) => entry.textContent?.trim() === label,
  );
}

async function click(label: string): Promise<void> {
  await act(async () => {
    button(label).click();
  });
}

async function fill(id: string, value: string): Promise<void> {
  await act(async () => {
    const input = host.querySelector<HTMLInputElement>(`#${id}`)!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function choose(id: string, value: string): Promise<void> {
  await act(async () => {
    const select = host.querySelector<HTMLSelectElement>(`#${id}`)!;
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(select, value);
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

async function toggle(): Promise<void> {
  await act(async () => {
    const checkbox = host.querySelector<HTMLInputElement>(
      '.contact-governance__check input',
    )!;
    checkbox.click();
  });
}

async function submitForm(): Promise<void> {
  await act(async () => {
    host
      .querySelector('.contact-governance__form')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
}

async function mount(
  contact: Contact = baseContact,
  canUpdate = true,
): Promise<void> {
  await act(async () => {
    root.render(
      <ContactGovernance
        organizationId="org-a"
        contact={contact}
        canUpdate={canUpdate}
        onUpdated={onUpdated}
      />,
    );
  });
}

async function fillConsentEvidence(): Promise<void> {
  await fill('consent-at', '2026-10-20T09:00');
  await fill('consent-source', '  Signed membership form  ');
  await fill('consent-evidence', 'CRM-2026-00123');
  await toggle();
}

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  document.cookie = 'tv_csrf=synthetic-csrf; path=/';
  requests = [];
  reply = undefined;
  onUpdated.mockReset();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      requests.push({
        url,
        method,
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
      });
      return reply?.(url) ?? json({});
    }),
  );
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  host.remove();
  vi.unstubAllGlobals();
});

describe('ContactGovernance', () => {
  it('explains that consent is not inferred from import or group membership', async () => {
    await mount();

    expect(host.textContent).toContain('No voice consent is recorded');
    expect(host.textContent).toContain('imported, added manually, or placed in a group');
    expect(host.textContent).toContain('irreversible');
  });

  it('requires every piece of consent evidence before showing the confirmation', async () => {
    await mount();
    await click('Record consent evidence');
    await submitForm();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain(
      'Enter when the contact gave consent',
    );
    expect(host.textContent).not.toContain('Record this consent evidence?');

    await fill('consent-at', '2026-10-20T09:00');
    await fill('consent-source', 'Signed form');
    await fill('consent-evidence', 'x');
    await submitForm();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain(
      '3–128 characters',
    );

    await fill('consent-evidence', 'CRM-2026-00123');
    await submitForm();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain(
      'Confirm that you verified the source',
    );

    expect(requests).toHaveLength(0);
  });

  it('records the exact consent body only after confirmation', async () => {
    reply = () =>
      json({
        ...baseContact,
        voiceConsent: 'RECORDED',
        voiceConsentAt: '2026-10-20T09:00:00.000Z',
      });
    await mount();

    await click('Record consent evidence');
    await fillConsentEvidence();
    await submitForm();

    expect(host.textContent).toContain('Record this consent evidence?');
    expect(requests).toHaveLength(0);

    await click('Confirm and record consent');

    expect(requests).toHaveLength(1);
    const request = requests[0]!;
    expect(request.method).toBe('POST');
    expect(request.url).toBe('/api/organizations/org-a/contacts/contact-1/voice-consent');
    expect(request.body).toEqual({
      consentedAt: new Date('2026-10-20T09:00').toISOString(),
      source: 'Signed membership form',
      purpose: 'voice_calling',
      evidenceReference: 'CRM-2026-00123',
      sourceVerified: true,
    });
    expect(onUpdated).toHaveBeenCalledWith(
      expect.objectContaining({ voiceConsent: 'RECORDED' }),
    );
    expect(host.textContent).toContain(
      'Voice consent evidence recorded. It cannot be edited from this application.',
    );
  });

  it('keeps the entered evidence on a server failure', async () => {
    reply = () =>
      json(
        { error: { code: 'consent_already_recorded', message: 'Consent is already recorded.' } },
        409,
      );
    await mount();

    await click('Record consent evidence');
    await fillConsentEvidence();
    await submitForm();
    await click('Confirm and record consent');

    expect(host.querySelector('[role="alert"]')?.textContent).toContain(
      'Consent is already recorded.',
    );
    expect(host.querySelector<HTMLInputElement>('#consent-evidence')!.value).toBe('CRM-2026-00123');
    // The form stays open with the entered evidence; nothing was saved.
    expect(host.textContent).toContain('Review consent record');
    expect(onUpdated).not.toHaveBeenCalled();
  });

  it('shows recorded consent as immutable and offers no edit control', async () => {
    await mount({
      ...baseContact,
      voiceConsent: 'RECORDED',
      voiceConsentAt: '2026-10-20T09:00:00.000Z',
    });

    expect(host.textContent).toContain('Consent evidence was recorded');
    expect(host.textContent).toContain('Consent is immutable');
    expect(maybeButton('Record consent evidence')).toBeUndefined();
    expect(host.querySelectorAll('form')).toHaveLength(0);
  });

  it('requires confirmation before suppressing and posts the exact reason', async () => {
    reply = () =>
      json({
        ...baseContact,
        suppressed: true,
        suppressedAt: '2026-10-27T10:00:00.000Z',
      });
    await mount();

    await click('Suppress contact');
    await choose('suppression-reason', 'invalid_number');
    await submitForm();

    expect(host.textContent).toContain('Suppress this contact?');
    expect(host.textContent).toContain('cannot be undone');
    expect(requests).toHaveLength(0);

    await click('Confirm suppression');

    expect(requests).toHaveLength(1);
    expect(requests[0]!.method).toBe('POST');
    expect(requests[0]!.url).toBe('/api/organizations/org-a/contacts/contact-1/suppress');
    expect(requests[0]!.body).toEqual({ reason: 'invalid_number' });
    expect(onUpdated).toHaveBeenCalledWith(expect.objectContaining({ suppressed: true }));
    expect(host.textContent).toContain('Contact suppressed.');
  });

  it('lets the operator go back from suppression without writing', async () => {
    await mount();

    await click('Suppress contact');
    await choose('suppression-reason', 'other');
    await submitForm();
    await click('Go back');

    expect(host.textContent).toContain('Review suppression');
    expect(host.textContent).not.toContain('Suppress this contact?');
    expect(requests).toHaveLength(0);
  });

  it('shows a suppressed contact as retained and offers no reverse control', async () => {
    await mount({
      ...baseContact,
      suppressed: true,
      suppressedAt: '2026-10-27T10:00:00.000Z',
    });

    expect(host.textContent).toContain('This contact is suppressed');
    expect(host.textContent).toContain('retained permanently');
    expect(maybeButton('Suppress contact')).toBeUndefined();
  });

  it('renders no governance controls without contact:update', async () => {
    await mount(baseContact, false);

    expect(maybeButton('Record consent evidence')).toBeUndefined();
    expect(maybeButton('Suppress contact')).toBeUndefined();
    expect(host.querySelectorAll('form')).toHaveLength(0);
    // The state is still explained to a read-only role.
    expect(host.textContent).toContain('No voice consent is recorded');
    expect(host.textContent).toContain('Suppression stops a contact');
  });
});
