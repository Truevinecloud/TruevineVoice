/**
 * ErrorState — error state component with title, description, optional
 * retry action and optional error details.
 */

import type { ReactElement } from 'react';

export interface ErrorStateProps {
  readonly title: string;
  readonly children: React.ReactNode;
  readonly action?: React.ReactNode;
  readonly details?: string;
  readonly className?: string;
}

export function ErrorState({
  title,
  children,
  action,
  details,
  className = '',
}: ErrorStateProps): ReactElement {
  return (
    <div className={`error-state ${className}`.trim()} role="alert">
      <h3 className="error-state-title">{title}</h3>
      <p className="error-state-description">{children}</p>
      {details && <p className="error-state-details">{details}</p>}
      {action && <div className="error-state-action">{action}</div>}
    </div>
  );
}
