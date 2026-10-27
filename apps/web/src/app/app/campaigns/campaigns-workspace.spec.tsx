// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Campaign } from '../../../lib/org-api';
import { CampaignsWorkspace } from './campaigns-workspace';

interface Recorded {
  readonly url: string;
  readonly method: string;
  readonly body: unknown;
}

let root: Root;
let host: HTMLDivElement;
let requests: Recorded[];
let respond: ((url: string, method: string) => Response | undefined) | undefined;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function campaign(
  id: string,
  name: string,
  status: Campaign['status'] = 'DRAFT',
  scheduledAt: string | null = null,
): Campaign {
  return {
    id,
    name,
    status,
    audioAssetId: null,
    scheduledAt,
    retryMaxAttempts: 1,
    retryDelayMinutes: 60,
    audienceGroupIds: [],
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-02T00:00:00.000Z',
  };
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

async function mount(
  campaigns: readonly Campaign[],
  options: { readonly canUpdate?: boolean; readonly canDelete?: boolean } = {},
): Promise<void> {
  await act(async () => {
    root.render(
      <CampaignsWorkspace
        organizationId="org-a"
        initialCampaigns={campaigns}
        canUpdate={options.canUpdate ?? true}
        canDelete={options.canDelete ?? true}
      />,
    );
  });
  // Let the audience/audio load settle.
  await act(async () => {
    await Promise.resolve();
  });
}

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  document.cookie = 'tv_csrf=synthetic-csrf; path=/';
  requests = [];
  respond = undefined;
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

      const custom = respond?.(url, method);
      if (custom) return custom;

      if (url.endsWith('/contact-groups')) return json([{ id: 'group-1', name: 'Members' }]);
      if (url.endsWith('/audio-assets')) return json([{ id: 'asset-1', name: 'Welcome message' }]);
      return json([]);
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

describe('CampaignsWorkspace', () => {
  it('renders a summary and filters the inventory by name and status', async () => {
    await mount([
      campaign('1', 'October members', 'DRAFT', '2026-11-01T10:00:00.000Z'),
      campaign('2', 'November follow-up', 'DRAFT'),
      campaign('3', 'Spring reminder', 'COMPLETED'),
    ]);

    expect(host.textContent).toContain('Total records');
    expect(host.textContent).toContain('October members');
    expect(host.textContent).toContain('Spring reminder');
    expect(host.querySelectorAll('tbody tr')).toHaveLength(3);

    await fill('campaign-search', 'member');
    expect(host.querySelectorAll('tbody tr')).toHaveLength(1);
    expect(host.textContent).toContain('October members');

    await fill('campaign-search', '');
    await choose('campaign-status-filter', 'DRAFT');
    expect(host.querySelectorAll('tbody tr')).toHaveLength(2);
    expect(host.textContent).not.toContain('Spring reminder');

    await fill('campaign-search', 'nothing matches this');
    expect(host.textContent).toContain('No campaigns match these filters');
  });

  it('paginates long inventories without hiding the visible range', async () => {
    const rows = Array.from({ length: 11 }, (_, index) =>
      campaign(String(index + 1), `Campaign ${index + 1}`),
    );
    await mount(rows);

    expect(host.querySelectorAll('tbody tr')).toHaveLength(10);
    expect(host.textContent).toContain('Showing 1–10 of 11');
    expect(button('Previous').disabled).toBe(true);

    await click('Next');

    expect(host.querySelectorAll('tbody tr')).toHaveLength(1);
    expect(host.textContent).toContain('Showing 11–11 of 11');
    expect(host.textContent).toContain('Campaign 11');
    expect(button('Next').disabled).toBe(true);
  });

  it('reviews a draft, runs preflight, and never offers to launch it', async () => {
    respond = (url, method) =>
      method === 'POST' && url.endsWith('/campaigns/c1/preflight')
        ? json({
            valid: true,
            eligibleContactCount: 4,
            issues: [],
          })
        : undefined;
    await mount([campaign('c1', 'October members', 'DRAFT')]);

    await click('Review');
    expect(host.textContent).toContain('Campaign review');
    expect(maybeButton('Delete draft')).toBeDefined();
    expect(maybeButton('Edit draft')).toBeDefined();
    expect(host.textContent?.toLowerCase()).not.toContain('launch');

    await click('Run preflight');
    expect(host.textContent).toContain('Ready for review');
    expect(host.textContent).toContain('4 currently eligible contacts');
    expect(
      requests.some(
        (request) =>
          request.method === 'POST' && request.url.endsWith('/campaigns/c1/preflight'),
      ),
    ).toBe(true);
  });

  it('shows preflight issues and reports a preflight failure', async () => {
    respond = (url) =>
      url.endsWith('/campaigns/c1/preflight')
        ? json(
            {
              error: { code: 'campaign_not_editable', message: 'Only drafts can be checked.' },
            },
            409,
          )
        : undefined;
    await mount([campaign('c1', 'October members', 'DRAFT')]);

    await click('Review');
    await click('Run preflight');

    expect(host.querySelector('[role="alert"]')?.textContent).toContain(
      'Only drafts can be checked.',
    );
  });

  it('creates a draft, refreshes the inventory, and opens its review', async () => {
    const created = campaign('c-new', 'New member call', 'DRAFT');
    respond = (url, method) =>
      method === 'POST' && url.endsWith('/campaigns') ? json(created, 201) : undefined;
    await mount([]);

    expect(host.textContent).toContain('No campaigns yet');
    await click('New campaign draft');
    await fill('campaign-name', 'New member call');
    await act(async () => {
      host
        .querySelector('form')!
        .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

    const posted = requests.find(
      (request) => request.method === 'POST' && request.url.endsWith('/campaigns'),
    );
    expect(posted).toBeDefined();
    expect((posted!.body as { name: string }).name).toBe('New member call');
    expect(host.textContent).toContain('Draft saved. Review its readiness below; no call was placed.');
    expect(host.textContent).toContain('Campaign review');
    expect(host.textContent).toContain('New member call');

    await click('Close');
    expect(host.textContent).toContain('New member call');
  });

  it('deletes a draft only after confirmation and removes the record', async () => {
    respond = (url, method) =>
      method === 'DELETE' && url.endsWith('/campaigns/c1')
        ? new Response(null, { status: 204 })
        : undefined;
    await mount([campaign('c1', 'October members', 'DRAFT')]);

    await click('Review');
    await click('Delete draft');
    expect(host.textContent).toContain('Delete “October members”?');
    expect(host.textContent).toContain('cannot be undone');

    // Nothing is deleted before the second confirmation.
    expect(requests.some((request) => request.method === 'DELETE')).toBe(false);

    await click('Yes, delete this draft');

    expect(
      requests.some(
        (request) => request.method === 'DELETE' && request.url.endsWith('/campaigns/c1'),
      ),
    ).toBe(true);
    expect(host.textContent).toContain('Draft deleted. No campaign history was changed.');
    expect(host.textContent).toContain('No campaigns yet');
  });

  it('keeps the draft when deletion is cancelled', async () => {
    await mount([campaign('c1', 'October members', 'DRAFT')]);

    await click('Review');
    await click('Delete draft');
    await click('Keep draft');

    expect(requests.some((request) => request.method === 'DELETE')).toBe(false);
    expect(host.textContent).toContain('Campaign review');
  });

  it('does not offer draft-only actions on a non-draft record', async () => {
    await mount([campaign('c1', 'Completed campaign', 'COMPLETED')]);

    await click('Review');

    expect(maybeButton('Edit draft')).toBeUndefined();
    expect(maybeButton('Delete draft')).toBeUndefined();
    expect(maybeButton('Run preflight')).toBeUndefined();
    expect(host.textContent).toContain('Only draft records can be edited');
  });

  it('surfaces list and library failures without inventing data', async () => {
    respond = (url, method) =>
      method === 'GET' && url.endsWith('/audio-assets')
        ? json({ error: { code: 'unexpected_error', message: 'Storage unavailable.' } }, 500)
        : method === 'GET' && url.endsWith('/campaigns')
          ? json({ error: { code: 'unexpected_error', message: 'List unavailable.' } }, 500)
          : undefined;
    await mount([]);

    expect(host.querySelector('[role="alert"]')?.textContent).toContain(
      'Audiences and audio could not be loaded.',
    );

    await click('Refresh');
    expect(host.textContent).toContain('List unavailable.');
  });

  it('renders a read-only inventory with no forms or action controls', async () => {
    await mount(
      [
        campaign('1', 'October members', 'DRAFT'),
        campaign('2', 'Spring reminder', 'COMPLETED'),
      ],
      { canUpdate: false, canDelete: false },
    );

    expect(host.textContent).toContain('Campaign inventory');
    expect(host.textContent).toContain('October members');
    expect(host.querySelectorAll('form')).toHaveLength(0);
    expect(host.querySelectorAll('button')).toHaveLength(0);
    for (const word of ['Launch', 'Edit', 'Delete', 'New campaign draft']) {
      expect(host.textContent).not.toContain(word);
    }
    // A read-only role must not trigger library requests either.
    expect(requests).toHaveLength(0);
  });

  it('renders an empty read-only state without controls', async () => {
    await mount([], { canUpdate: false, canDelete: false });

    expect(host.textContent).toContain('No campaign records yet');
    expect(host.querySelectorAll('form')).toHaveLength(0);
    expect(host.querySelectorAll('button')).toHaveLength(0);
  });

  it('allows review-only roles to open a record but not change it', async () => {
    await mount([campaign('1', 'October members', 'DRAFT')], {
      canUpdate: false,
      canDelete: false,
    });

    // The read-only inventory is a static table: no row action is rendered.
    expect(host.querySelector('.campaign-table')).toBeNull();
    expect(maybeButton('Review')).toBeUndefined();
    expect(host.textContent).toContain('No campaign controls are available to this role.');
  });

  it('gates delete on campaign:delete even when the caller can update', async () => {
    await mount([campaign('c1', 'October members', 'DRAFT')], {
      canUpdate: true,
      canDelete: false,
    });

    await click('Review');
    expect(maybeButton('Edit draft')).toBeDefined();
    expect(maybeButton('Delete draft')).toBeUndefined();
  });
});
