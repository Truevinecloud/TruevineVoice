// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError } from '../../lib/api';
import AuditorAuditPage from './audit/page';
import AuditorOverviewPage from './page';
import AuditorOrganizationsPage from './organizations/page';

vi.mock('../../lib/api', async (original) => ({
  ...(await original<typeof import('../../lib/api')>()), api: vi.fn(),
}));
const mockApi = vi.mocked(api);
let root: Root;
let host: HTMLDivElement;
async function settle() {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 15)); });
}
async function mount(page = <AuditorAuditPage />) {
  host = document.createElement('div'); document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(page));
  await settle();
}
function button(text: string) {
  return Array.from(host.querySelectorAll('button')).find((item) => item.textContent === text)!;
}
afterEach(() => {
  if (root) act(() => root.unmount());
  host?.remove(); vi.resetAllMocks();
});

describe('RBAC-011 Auditor pages', () => {
  it('identifies the sensitive action audit and explains its purpose', async () => {
    mockApi.mockImplementation(() => new Promise(() => {}));
    await mount();
    expect(host.querySelector('h1')?.textContent).toBe('Sensitive Action Audit');
    expect(host.querySelector('.subtitle')?.textContent).toContain('platform actions, actors, targets, and outcomes');
    expect(host.querySelector('.subtitle')?.textContent).toContain('read-only, newest first');
    expect(host.querySelector('.subtitle')?.textContent).toContain('UTC');
  });

  it.each([<AuditorAuditPage key="audit" />, <AuditorOverviewPage key="overview" />, <AuditorOrganizationsPage key="organizations" />])('announces loading and read-only access', async (page) => {
    mockApi.mockImplementation(() => new Promise(() => {}));
    await mount(page);
    expect(host.textContent).toContain('Read-only workspace');
    expect(host.querySelector('[role="status"]')?.textContent).toContain('Loading');
  });

  it.each([401, 403])('hides audit records and controls after %s', async (status) => {
    mockApi.mockRejectedValue(new ApiError(status));
    await mount();
    expect(host.textContent).toContain(status === 401 ? 'Sign in' : 'does not have Auditor access');
    expect(host.querySelector('form')).toBeNull();
    expect(host.querySelector('table')).toBeNull();
    expect(mockApi).toHaveBeenCalledTimes(1);
  });

  it('keeps pagination bound to the applied filter and only issues GET requests', async () => {
    mockApi.mockImplementation(async (path) => path === '/platform/audit/me' ? { platformRole: 'AUDITOR' } : { events: [], nextCursor: 'identity:first' });
    await mount();
    const input = host.querySelector('input')!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setter.call(input, 'platform.audit.overview_viewed');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => button('Load more').click()); await settle();
    expect(mockApi).toHaveBeenLastCalledWith('/platform/audit/audit?cursor=identity%3Afirst', expect.any(Object));
    await act(async () => host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    await settle();
    expect(mockApi).toHaveBeenLastCalledWith('/platform/audit/audit?action=platform.audit.overview_viewed', expect.any(Object));
    expect(mockApi.mock.calls.every(([, options]) => !options?.method || options.method === 'GET')).toBe(true);
  });

  it('offers recovery without showing an empty success on failure', async () => {
    mockApi.mockResolvedValueOnce({ platformRole: 'AUDITOR' }).mockRejectedValueOnce(new ApiError(503));
    await mount();
    expect(host.textContent).toContain('temporarily unavailable');
    expect(host.textContent).not.toContain('No platform audit events');
    mockApi.mockResolvedValueOnce({ platformRole: 'AUDITOR' }).mockResolvedValueOnce({ events: [], nextCursor: null });
    await act(async () => button('Retry').click()); await settle();
    expect(host.textContent).toContain('No platform audit events');
  });

  it('aborts outstanding audit requests on navigation', async () => {
    mockApi.mockImplementation(() => new Promise(() => {}));
    await mount();
    const signal = mockApi.mock.calls[0]![1]!.signal!;
    await act(async () => root.unmount());
    expect(signal.aborted).toBe(true);
  });

  it('removes previously loaded organization data when access is revoked', async () => {
    mockApi.mockResolvedValueOnce({ platformRole: 'AUDITOR' }).mockResolvedValueOnce({
      organizations: [{ id: 'org', name: 'Example tenant', slug: 'example', status: 'ACTIVE', createdAt: '2026-10-20T00:00:00Z', memberCount: 2 }],
      nextCursor: 'example',
    });
    await mount(<AuditorOrganizationsPage />);
    expect(host.textContent).toContain('Example tenant');
    mockApi.mockRejectedValueOnce(new ApiError(403));
    await act(async () => button('Load more').click()); await settle();
    expect(host.textContent).toContain('does not have Auditor access');
    expect(host.textContent).not.toContain('Example tenant');
    expect(host.querySelector('table')).toBeNull();
    expect(host.querySelector('button')).toBeNull();
  });
});
