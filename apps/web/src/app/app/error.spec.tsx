import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import AppError from './error';

describe('workspace error fallback', () => {
  it('explains the problem without exposing the underlying error', () => {
    const markup = renderToStaticMarkup(
      <AppError error={new Error('database password=never-render-this')} reset={vi.fn()} />,
    );

    expect(markup).toContain('role="alert"');
    expect(markup).toContain('Temporary problem');
    expect(markup).toContain('We could not open this workspace page');
    expect(markup).toContain('saved campaign data are unchanged');
    expect(markup).not.toContain('never-render-this');
  });

  it('offers a single retry action for unsaved work', () => {
    const markup = renderToStaticMarkup(<AppError error={new Error('load failed')} reset={vi.fn()} />);

    expect(markup).toContain('form half-finished');
    expect(markup).toContain('after the page reloads');
    expect(markup).toMatch(/<button[^>]*type="button"[^>]*>Try again<\/button>/);
  });
});
