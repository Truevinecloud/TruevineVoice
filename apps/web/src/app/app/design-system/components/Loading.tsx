'use client';

import type { ReactNode } from 'react';

/**
 * Shared loading state component.
 *
 * Consolidates the web portal's three loading patterns (workspace skeleton,
 * navigation topbar shimmer, and app-loading-card) into a single presentational
 * component with consistent focus management and reduced-motion support.
 *
 * Accepts a `message` for the live-announced status text and optional `children`
 * for a custom visual skeleton. When no children are provided, a default 3-line
 * skeleton is rendered.
 */
export function Loading({
  message = 'Loading…',
  children,
}: {
  readonly message?: string;
  readonly children?: ReactNode;
}): React.JSX.Element {
  return (
    <div className="ds-loading" aria-busy="true" role="status">
      <p className="ds-loading__message">{message}</p>
      <div className="ds-loading__skeleton" aria-hidden="true">
        {children ?? (
          <>
            <div className="ds-loading__line ds-loading--wide" />
            <div className="ds-loading__line ds-loading--medium" />
            <div className="ds-loading__line ds-loading--narrow" />
          </>
        )}
      </div>
    </div>
  );
}
