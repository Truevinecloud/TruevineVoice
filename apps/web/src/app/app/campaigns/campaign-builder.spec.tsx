// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { localDateTimeValue } from '../../../lib/datetime';
import type { Campaign } from '../../../lib/org-api';
import { CampaignBuilder } from './campaign-builder';

const baseCampaign: Campaign = {
  id: 'campaign-id',
  name: 'QA call',
  status: 'DRAFT',
  audioAssetId: 'asset-1',
  scheduledAt: '2026-11-05T14:30:00.000Z',
  retryMaxAttempts: 2,
  retryDelayMinutes: 30,
  audienceGroupIds: ['group-1'],
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-02T00:00:00.000Z',
};

const groups = [{ id: 'group-1', name: 'Members' }];
const assets = [{ id: 'asset-1', name: 'Welcome message' }];

function setInputValue(input: HTMLInputElement, value: string): void {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('CampaignBuilder', () => {
  let root: Root | undefined;
  let host: HTMLDivElement | undefined;
  const onSaved = vi.fn();
  const onCancel = vi.fn();

  afterEach(() => {
    if (root) act(() => root?.unmount());
    host?.remove();
    root = undefined;
    host = undefined;
    onSaved.mockReset();
    onCancel.mockReset();
    vi.unstubAllGlobals();
  });

  async function mount(campaign: Campaign | null = null): Promise<void> {
    document.cookie = 'tv_csrf=test-token';
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    await act(async () => {
      root?.render(
        <CampaignBuilder
          organizationId="org-id"
          campaign={campaign}
          groups={groups}
          assets={assets}
          onSaved={onSaved}
          onCancel={onCancel}
        />,
      );
    });
  }

  function captureRequests(): Array<{ readonly url: string; readonly body: unknown }> {
    const requests: Array<{ readonly url: string; readonly body: unknown }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        requests.push({
          url: String(input),
          body: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
        });
        return new Response(JSON.stringify({ ...baseCampaign, name: 'QA call' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }),
    );
    return requests;
  }

  it('renders the draft sections and never offers a launch action', async () => {
    await mount();

    for (const section of [
      'Campaign details',
      'Message audio',
      'Target audience',
      'Schedule & retry settings',
      'Review before saving',
    ]) {
      expect(host!.textContent).toContain(section);
    }
    expect(host!.textContent).toContain('Welcome message');
    expect(host!.textContent).toContain('Members');
    expect(host!.querySelector('button[type="submit"]')?.textContent).toBe('Save draft');
    expect(host!.textContent?.toLowerCase()).not.toContain('launch');
  });

  it('shows an empty audience and audio state without requesting them', async () => {
    document.cookie = 'tv_csrf=test-token';
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await act(async () => {
      root?.render(
        <CampaignBuilder
          organizationId="org-id"
          campaign={null}
          groups={[]}
          assets={[]}
          onSaved={onSaved}
          onCancel={onCancel}
        />,
      );
    });

    expect(host.textContent).toContain('No audio assets yet');
    expect(host.textContent).toContain('No contact groups available');
    // The workspace owns these lists; the editor must not fetch per row.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('displays a stored instant in local time and submits an offset-bearing instant', async () => {
    const requests = captureRequests();
    await mount(baseCampaign);

    const schedule = host!.querySelector<HTMLInputElement>('#campaign-scheduled-at')!;
    // Regression for the UTC-in-a-local-control bug.
    expect(schedule.value).toBe(localDateTimeValue(baseCampaign.scheduledAt));
    expect(schedule.value).not.toBe('2026-11-05T14:30');

    await act(async () => {
      setInputValue(schedule, '2026-12-24T09:15');
    });

    const form = host!.querySelector('form')!;
    await act(async () => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

    const patch = requests.find((request) => request.url.endsWith('/campaigns/campaign-id'));
    expect(patch).toBeDefined();
    const body = patch!.body as { scheduledAt: string; audienceGroupIds: string[] };
    expect(body.scheduledAt).toBe(new Date('2026-12-24T09:15').toISOString());
    expect(body.scheduledAt).toMatch(/Z$/);
    expect(body.audienceGroupIds).toEqual(['group-1']);
    expect(onSaved).toHaveBeenCalledTimes(1);
  });

  it('creates a draft and clears the schedule when the operator removes it', async () => {
    const requests = captureRequests();
    await mount(null);

    const name = host!.querySelector<HTMLInputElement>('#campaign-name')!;
    await act(async () => {
      setInputValue(name, 'New member call');
    });

    const form = host!.querySelector('form')!;
    await act(async () => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

    const post = requests.find((request) => request.url.endsWith('/campaigns'));
    expect(post).toBeDefined();
    const body = post!.body as { name: string; scheduledAt: string | null };
    expect(body.name).toBe('New member call');
    expect(body.scheduledAt).toBeNull();
    expect(onSaved).toHaveBeenCalledTimes(1);
  });

  it('reports a save failure without claiming the draft was saved', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        return new Response(
          JSON.stringify({
            error: { code: 'campaign_not_editable', message: 'Only drafts can be edited.' },
          }),
          { status: 409, headers: { 'content-type': 'application/json' } },
        );
      }),
    );
    await mount(baseCampaign);

    const form = host!.querySelector('form')!;
    await act(async () => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

    const alert = host!.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain('Only drafts can be edited.');
    expect(onSaved).not.toHaveBeenCalled();
  });
});
