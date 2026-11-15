// @vitest-environment happy-dom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, request } from '../../lib/api';
import { OrganizationWorkspace } from './OrganizationWorkspace';
import type { MembershipSummary } from '../../lib/session';
const navigation = vi.hoisted(() => ({ organization: 'a', push: vi.fn(), refresh: vi.fn() }));
vi.mock('next/navigation', () => ({
  usePathname: () => '/app',
  useSearchParams: () => new URLSearchParams(`organization=${navigation.organization}`),
  useRouter: () => navigation,
}));
vi.mock('../../lib/api', async (original) => ({
  ...(await original<typeof import('../../lib/api')>()),
  request: vi.fn(),
}));
vi.mock('./SignOutButton', () => ({ SignOutButton: () => <button>Sign out</button> }));
const a: MembershipSummary = {
  organizationId: 'a',
  organizationSlug: 'alpha',
  organizationName: 'Alpha',
  role: 'OWNER',
  permissions: ['organization:read'],
};
const b: MembershipSummary = {
  ...a,
  organizationId: 'b',
  organizationName: 'Beta',
  role: 'VIEWER',
};
let root: Root;
let host: HTMLDivElement;
beforeEach(() =>
  vi
    .mocked(request)
    .mockResolvedValue({ userId: 'user-a', termsAccepted: true, memberships: [a, b] }),
);
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 15));
  });
}
function TenantContent() {
  const [value, setValue] = useState('');
  return (
    <div>
      Private {navigation.organization}
      <button onClick={() => setValue('private draft A')}>Edit draft</button>
      <span>{value}</span>
    </div>
  );
}
function view() {
  return (
    <OrganizationWorkspace memberships={[a, b]} email="qa@example.invalid" userId="user-a">
      <TenantContent />
    </OrganizationWorkspace>
  );
}
async function mount() {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(view()));
  await settle();
}
async function select(id: string) {
  await act(async () => {
    const select = host.querySelector('select')!;
    select.value = id;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
}
afterEach(() => {
  if (root) act(() => root.unmount());
  host?.remove();
  navigation.organization = 'a';
  vi.resetAllMocks();
});
describe('secure organization workspace transitions', () => {
  it('shows only session organizations and refuses a direct unauthorized URL without rendering content', async () => {
    navigation.organization = 'foreign';
    await mount();
    expect(host.textContent).toContain('Choose an authorized workspace');
    expect(host.textContent).not.toContain('Private');
    expect(host.querySelector('.sidebar-organization')?.textContent).not.toContain('Alpha');
    expect(Array.from(host.querySelectorAll('option')).map((item) => item.value)).toEqual([
      '',
      'a',
      'b',
    ]);
    expect(navigation.push).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
    expect(host.querySelector('a[href="/app"]')).not.toBeNull();
  });
  it('hides previous content while revalidating membership and refreshes the selected workspace', async () => {
    let resolve!: (value: unknown) => void;
    await mount();
    navigation.refresh.mockClear();
    vi.mocked(request).mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    await select('b');
    expect(host.textContent).toContain('Loading your authorized workspace');
    expect(host.textContent).not.toContain('Private a');
    expect(host.querySelector('select')!.disabled).toBe(true);
    await act(async () => resolve({ userId: 'user-a', termsAccepted: true, memberships: [a, b] }));
    expect(navigation.push).toHaveBeenCalledWith('/app?organization=b');
    expect(navigation.refresh).toHaveBeenCalled();
    expect(vi.mocked(request).mock.calls[0]?.[0]).toBe('/me');
  });
  it('remounts drafts on organization changes and browser history navigation', async () => {
    await mount();
    await act(async () =>
      Array.from(host.querySelectorAll('button'))
        .find((item) => item.textContent === 'Edit draft')!
        .click(),
    );
    expect(host.textContent).toContain('private draft A');
    navigation.organization = 'b';
    await act(async () => root.render(view()));
    await settle();
    expect(host.textContent).toContain('Private b');
    expect(host.textContent).not.toContain('private draft A');
    navigation.organization = 'a';
    await act(async () => root.render(view()));
    await settle();
    expect(host.textContent).not.toContain('private draft A');
  });
  it('refuses a membership removed since the layout loaded and leaves a safe recovery state', async () => {
    await mount();
    vi.mocked(request).mockResolvedValueOnce({
      userId: 'user-a',
      termsAccepted: true,
      memberships: [a],
    });
    await select('b');
    await settle();
    expect(navigation.push).not.toHaveBeenCalled();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('access may have changed');
    expect(host.textContent).toContain('Private a');
  });
  it('hides tenant content after session expiration instead of restoring previous data', async () => {
    await mount();
    vi.mocked(request).mockRejectedValueOnce(new ApiError(401, 'session_expired', 'Expired'));
    await select('b');
    await settle();
    expect(host.textContent).not.toContain('Private a');
    expect(host.querySelector('a[href^="/sign-in"]')).not.toBeNull();
    expect(navigation.push).not.toHaveBeenCalled();
  });
  it('aborts pending membership verification on navigation', async () => {
    await mount();
    vi.mocked(request).mockImplementationOnce(() => new Promise(() => {}));
    await select('b');
    const signal = vi.mocked(request).mock.calls.at(-1)![1]!.signal!;
    navigation.organization = 'a-invalid';
    await act(async () => root.render(view()));
    expect(signal.aborted).toBe(true);
  });

  it('revalidates a restored tab and conceals content after membership is removed', async () => {
    await mount();
    expect(host.textContent).toContain('Private a');
    vi.mocked(request).mockResolvedValueOnce({
      userId: 'user-a',
      termsAccepted: true,
      memberships: [b],
    });
    await act(async () => window.dispatchEvent(new Event('pageshow')));
    expect(host.textContent).toContain('Choose an authorized workspace');
    expect(host.textContent).not.toContain('Private a');
  });

  it('removes cached navigation and content when another account owns the session', async () => {
    vi.mocked(request).mockResolvedValueOnce({
      userId: 'another-user',
      termsAccepted: true,
      memberships: [],
    });
    await mount();
    expect(host.textContent).not.toContain('Private a');
    expect(host.textContent).not.toContain('Alpha');
    expect(host.textContent).not.toContain('qa@example.invalid');
    expect(host.querySelector('a[href^="/sign-in"]')).not.toBeNull();
  });

  it('preserves a same-workspace draft across successful restored-tab verification', async () => {
    await mount();
    navigation.refresh.mockClear();
    await act(async () =>
      Array.from(host.querySelectorAll('button'))
        .find((item) => item.textContent === 'Edit draft')!
        .click(),
    );
    await act(async () => window.dispatchEvent(new Event('pageshow')));
    expect(host.textContent).toContain('private draft A');
    expect(navigation.refresh).toHaveBeenCalled();
  });
});
