// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { RouteAlias } from './route-alias';

const router = vi.hoisted(() => ({ replace: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => router }));

let root: Root;
let host: HTMLDivElement;

afterEach(() => {
  if (root) act(() => root.unmount());
  host?.remove();
  vi.resetAllMocks();
});

describe('RouteAlias', () => {
  it('redirects without changing the configured base path', async () => {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);

    await act(async () => {
      root.render(<RouteAlias href="/platform-admin" label="platform admins" />);
    });

    expect(host.querySelector('[role="status"]')?.textContent).toContain('platform admins');
    expect(router.replace).toHaveBeenCalledWith('/platform-admin');
  });
});
