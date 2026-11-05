import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

import OperationsDashboard from './operations-dashboard';

describe('OperationsDashboard', () => {
  it('renders the operations workspace shell', () => {
    const markup = renderToStaticMarkup(<OperationsDashboard />);
    expect(markup).toContain('PLATFORM OPERATIONS');
    expect(markup).toContain('Operations');
  });

  it('renders an unauthenticated sign-in state', () => {
    const markup = renderToStaticMarkup(<OperationsDashboard />);
    expect(markup).toContain('Platform sign in');
  });
});
