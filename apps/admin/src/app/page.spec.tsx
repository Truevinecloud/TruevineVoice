import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

import AdminHomePage from './page';

describe('Operations Admin page', () => {
  it('renders the operations console', () => {
    const markup = renderToStaticMarkup(<AdminHomePage />);

    expect(markup).toContain('Operations');
    expect(markup).toContain('Platform sign in');
  });

  it('retains the platform-admin audience metadata', () => {
    const markup = renderToStaticMarkup(<AdminHomePage />);

    expect(markup).toContain('Operations');
    expect(markup).toContain('Platform sign in');
  });
});
