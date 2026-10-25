// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CampaignBuilder } from './campaign-builder';

describe('CampaignBuilder', () => {
  let root: Root | undefined;
  let host: HTMLDivElement | undefined;

  afterEach(() => {
    if (root) act(() => root?.unmount());
    host?.remove();
    root = undefined;
    host = undefined;
    vi.unstubAllGlobals();
  });

  it('saves a draft, offers preflight, and does not expose a launch action', async () => {
    document.cookie = 'tv_csrf=test-token';
    const campaign = {
      id: 'campaign-id',
      name: 'QA call',
      status: 'DRAFT',
      audioAssetId: null,
      scheduledAt: null,
      retryMaxAttempts: 1,
      retryDelayMinutes: 60,
      audienceGroupIds: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const requests: Array<{ readonly url: string; readonly method: string }> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, method: init?.method ?? 'GET' });
      const payload = url.includes('/contact-groups')
        ? []
        : url.includes('/audio-assets')
          ? []
          : url.includes('/preflight')
            ? {
                valid: false,
                eligibleContactCount: 0,
                issues: [{ code: 'audio_required', message: 'Select a message audio asset.' }],
              }
            : campaign;
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    await act(async () => {
      root?.render(<CampaignBuilder organizationId="org-id" initialCampaigns={[]} canUpdate />);
    });
    await act(async () => {
      await Promise.resolve();
    });

    for (const section of [
      'Campaign Details',
      'Message Audio',
      'Target Audience',
      'Schedule & Retry Settings',
      'Review & Preflight',
    ]) {
      expect(host.textContent).toContain(section);
    }
    expect(host.textContent).toContain('No audio assets yet');
    expect(host.textContent).toContain('No contact groups available');
    expect(host.querySelector('button[type="submit"]')?.textContent).toBe('Save Draft');
    expect(
      [...host.querySelectorAll('button')].some((button) => button.textContent === 'Run Preflight'),
    ).toBe(true);

    const name = host.querySelector('input[maxlength="200"]') as HTMLInputElement;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
      name,
      'QA call',
    );
    await act(async () => {
      name.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const form = host.querySelector('form')!;
    await act(async () => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    expect(
      requests.some(({ url, method }) => url.endsWith('/campaigns') && method === 'POST'),
    ).toBe(true);
    expect(host.textContent).toContain('Draft saved. Run preflight to review readiness.');
    expect(host.textContent).toContain('Run Preflight');
    expect(host.textContent?.toLowerCase()).not.toContain('launch campaign');

    const preflight = [...host.querySelectorAll('button')].find(
      (button) => button.textContent === 'Run Preflight',
    )!;
    await act(async () => {
      preflight.click();
    });
    expect(host.textContent).toContain('Preflight found items to resolve.');
    expect(host.textContent).toContain('Select a message audio asset.');
    expect(requests.some(({ url }) => url.endsWith('/campaigns/campaign-id/preflight'))).toBe(true);
  });
});
