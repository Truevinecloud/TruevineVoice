// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError, ensureCsrfToken, request } from '../../../../lib/api';
import { CreateRoleForm } from './CreateRoleForm';

const { push } = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));
vi.mock('../../../../lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../lib/api')>()),
  ensureCsrfToken: vi.fn(),
  request: vi.fn(),
}));

describe('CreateRoleForm', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    act(() =>
      root.render(
        <CreateRoleForm
          organizationId="tenant-a"
          organizationName="Alpha"
          delegablePermissions={['organization:read']}
        />,
      ),
    );
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });

  const enterName = (host: HTMLDivElement, name: string) => {
    const input = host.querySelector<HTMLInputElement>('input[name="name"], #name')!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, name);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  };

  const submit = (host: HTMLDivElement) =>
    act(async () => {
      host
        .querySelector('form')!
        .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

  it('toggles only delegable category permissions and creates a role in the selected tenant', async () => {
    const bulk = host.querySelector<HTMLInputElement>(
      '[aria-label="Select all Organization permissions"]',
    )!;
    expect(host.querySelectorAll('input[type="checkbox"]')).toHaveLength(2);

    act(() => bulk.click());
    expect(bulk.checked).toBe(true);
    expect(bulk.getAttribute('aria-checked')).toBe('true');
    act(() => bulk.click());
    expect(bulk.checked).toBe(false);
    act(() => bulk.click());

    enterName(host, '  Reviewers  ');
    vi.mocked(request).mockResolvedValueOnce({ id: 'new-role' });
    await submit(host);

    expect(ensureCsrfToken).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledWith('/organizations/tenant-a/roles', {
      method: 'POST',
      body: { name: 'Reviewers', description: null, permissions: ['organization:read'] },
    });
    expect(push).toHaveBeenCalledWith('/app/roles/new-role?organization=tenant-a');
  });

  it('keeps the form open when the server denies role creation', async () => {
    enterName(host, 'Reviewers');
    vi.mocked(request).mockRejectedValueOnce(new ApiError(403, 'forbidden', 'Denied'));
    await submit(host);

    expect(host.querySelector('[role="alert"]')?.textContent).toBe(
      'You do not have permission to create this role.',
    );
    expect(push).not.toHaveBeenCalled();
    expect(host.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(false);
  });
});
