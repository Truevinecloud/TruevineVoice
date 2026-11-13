// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError } from '../lib/api';
import { PlatformShell } from './PlatformShell';

const router = vi.hoisted(() => ({ replace: vi.fn(), refresh: vi.fn() }));
vi.mock('next/navigation', () => ({ usePathname: () => '/technical', useRouter: () => router }));
vi.mock('../lib/api', async (original) => ({
  ...(await original<typeof import('../lib/api')>()),
  api: vi.fn(),
}));
const mockApi = vi.mocked(api);
let root: Root;
let host: HTMLDivElement;
async function mount() {
  mockApi.mockResolvedValue({ platformRole: 'TECHNICAL_ADMIN' });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () =>
    root.render(
      <PlatformShell>
        <p>Technical workspace</p>
      </PlatformShell>,
    ),
  );
}
function signOutButton() {
  return host.querySelector<HTMLButtonElement>('.platform-shell-signout')!;
}
afterEach(() => {
  if (root) act(() => root.unmount());
  host?.remove();
  vi.resetAllMocks();
});
describe('platform session logout', () => {
  it('keeps the session visible on failure and lets the user retry', async () => {
    await mount();
    mockApi.mockRejectedValueOnce(new ApiError(503));
    await act(async () => signOutButton().click());
    expect(host.querySelector('[role="alert"]')?.textContent).toContain(
      'session may still be active',
    );
    expect(signOutButton().disabled).toBe(false);
    expect(router.replace).not.toHaveBeenCalled();
    mockApi.mockResolvedValue(undefined);
    await act(async () => signOutButton().click());
    expect(mockApi).toHaveBeenCalledWith('/auth/sign-out', { method: 'POST' });
    expect(router.replace).toHaveBeenCalledWith('/');
    expect(router.refresh).toHaveBeenCalledOnce();
    expect(host.querySelector('.platform-shell-signout')).toBeNull();
  });
});
