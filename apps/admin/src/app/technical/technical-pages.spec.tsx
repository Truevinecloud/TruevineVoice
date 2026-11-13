// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError } from '../../lib/api';
import TechnicalLogsPage from './logs/page';
import TechnicalAuditPage from './audit/page';

vi.mock('../../lib/api', async (original) => ({
  ...(await original<typeof import('../../lib/api')>()),
  api: vi.fn(),
}));
const mockApi = vi.mocked(api);
let root: Root;
let host: HTMLDivElement;
async function mount(page: 'logs' | 'audit' = 'logs') {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () =>
    root.render(page === 'logs' ? <TechnicalLogsPage /> : <TechnicalAuditPage />),
  );
}
afterEach(() => {
  if (root) act(() => root.unmount());
  host?.remove();
  vi.resetAllMocks();
});

describe('Technical Admin pages', () => {
  it('shows loading while diagnostics are pending', async () => {
    mockApi.mockImplementation(() => new Promise(() => {}));
    await mount();
    expect(host.textContent).toContain('Loading logs availability');
    expect(host.querySelector('[role="status"]')).not.toBeNull();
  });
  it('loads real log availability and refreshes without offering unsupported filters', async () => {
    mockApi.mockResolvedValue({ status: 'not_configured', entries: [], detail: 'stdout only' });
    await mount();
    expect(host.textContent).toContain('missing capability');
    expect(host.textContent).toContain('correlation IDs require a queryable log store');
    expect(host.querySelector('input')).toBeNull();
    await act(async () =>
      Array.from(host.querySelectorAll('button'))
        .find((button) => button.textContent === 'Refresh')!
        .click(),
    );
    expect(mockApi).toHaveBeenCalledTimes(2);
    expect(mockApi).toHaveBeenLastCalledWith(
      '/platform/technical/logs',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });
  it('recovers from an API error with Retry', async () => {
    mockApi
      .mockRejectedValueOnce(new ApiError(503))
      .mockResolvedValueOnce({ status: 'not_configured', entries: [], detail: 'stdout only' });
    await mount();
    expect(host.textContent).toContain('temporarily unavailable');
    await act(async () => host.querySelector('button')!.click());
    expect(host.textContent).toContain('stdout only');
  });
  it.each([401, 403])('renders %s without diagnostics or an automatic retry', async (status) => {
    mockApi.mockRejectedValue(new ApiError(status));
    await mount();
    expect(host.textContent).toContain(
      status === 401 ? 'Sign in' : 'does not have Technical Admin access',
    );
    expect(host.querySelector('button')).toBeNull();
    expect(host.textContent).not.toContain('Live response');
  });
  it('ignores a stale diagnostics response after navigating away', async () => {
    let resolveFirst!: (value: unknown) => void;
    mockApi.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFirst = resolve;
        }),
    );
    mockApi.mockResolvedValue({ status: 'not_configured', entries: [], detail: 'new response' });
    await mount();
    const firstSignal = mockApi.mock.calls[0]![1]!.signal!;
    // Unmounting cancels a request even if the transport later resolves it.
    await act(async () => root.unmount());
    host.remove();
    expect(firstSignal.aborted).toBe(true);
    await mount();
    await act(async () =>
      resolveFirst({ status: 'not_configured', entries: [], detail: 'stale response' }),
    );
    expect(host.textContent).toContain('new response');
    expect(host.textContent).not.toContain('stale response');
  });
  it.each([
    [403, 'technical_audit_scope', 'Only platform-operation events are available'],
    [400, 'invalid_action', 'Unknown audit action'],
    [404, 'audit_cursor_not_found', 'That audit position is unavailable'],
  ] as const)(
    'explains audit query error %s/%s and recovers by clearing it',
    async (status, code, message) => {
      mockApi.mockRejectedValueOnce(new ApiError(status, code));
      mockApi.mockResolvedValue({ events: [], nextCursor: null });
      await mount('audit');
      expect(host.querySelector('[role="alert"]')?.textContent).toContain(message);
      expect(host.textContent).not.toContain('does not have Technical Admin access');
      await act(async () =>
        Array.from(host.querySelectorAll('button'))
          .find((button) => button.textContent === 'Clear filter')!
          .click(),
      );
      expect(host.textContent).toContain('No platform audit events');
      expect(host.querySelector('[role="alert"]')).toBeNull();
    },
  );
  it('renders a privacy-safe audit response and keeps pagination tied to the applied filter', async () => {
    mockApi.mockResolvedValue({
      events: [
        {
          id: 'one',
          trail: 'identity',
          action: 'platform.technical.overview_viewed',
          outcome: 'SUCCESS',
          scope: null,
          occurredAt: '2026-11-12T00:00:00Z',
        },
      ],
      nextCursor: 'identity:one',
    });
    await mount('audit');
    expect(host.textContent).toContain('Identity withheld');
    const input = host.querySelector('input')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
        input,
        'platform.technical.logs_viewed',
      );
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () =>
      host
        .querySelector('form')!
        .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
    );
    expect(mockApi).toHaveBeenLastCalledWith(
      '/platform/technical/audit?action=platform.technical.logs_viewed',
      expect.any(Object),
    );
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
        input,
        'unapplied',
      );
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () =>
      Array.from(host.querySelectorAll('button'))
        .find((button) => button.textContent === 'Load more')!
        .click(),
    );
    expect(mockApi).toHaveBeenLastCalledWith(
      '/platform/technical/audit?action=platform.technical.logs_viewed&cursor=identity%3Aone',
      expect.any(Object),
    );
  });
});
