/**
 * Loading — accessible loading state.
 *
 * Renders a spinner with optional descriptive text. Uses
 * aria-busy="true" to indicate the region is loading.
 */

import type { ReactElement } from 'react';

export interface LoadingProps {
  readonly message?: string;
  readonly className?: string;
}

export function Loading({ message, className = '' }: LoadingProps): ReactElement {
  return (
    <div className={`loading ${className}`.trim()} role="status" aria-busy="true">
      <span className="loading-spinner" aria-hidden="true" />
      {message && <span className="loading-message">{message}</span>}
    </div>
  );
}
