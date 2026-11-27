import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import AdminError from './error';

describe('platform error fallback', () => {
  it('reassures operators without exposing the underlying error', () => {
    const markup = renderToStaticMarkup(
      <AdminError error={new Error('internal token=never-render-this')} reset={vi.fn()} />,
    );

    expect(markup).toContain('role="alert"');
    expect(markup).toContain('Temporary problem');
    expect(markup).toContain('This platform page did not load');
    expect(markup).toContain('Saved platform data is unchanged');
    expect(markup).not.toContain('never-render-this');
  });

  it('warns against repeating a part-finished action and offers retry', () => {
    const markup = renderToStaticMarkup(
      <AdminError error={new Error('render failed')} reset={vi.fn()} />,
    );

    expect(markup).toContain('check the current state after retrying');
    expect(markup).toContain('before repeating it');
    expect(markup).toMatch(/<button[^>]*type="button"[^>]*>Try again<\/button>/);
  });
});
