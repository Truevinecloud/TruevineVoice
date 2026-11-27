/**
 * EmptyState — empty state component with optional illustration symbol,
 * title, description and action.
 */

import type { ReactElement } from 'react';

export interface EmptyStateProps {
  readonly title: string;
  readonly children: React.ReactNode;
  readonly action?: React.ReactNode;
  readonly symbol?: string;
  readonly className?: string;
}

export function EmptyState({
  title,
  children,
  action,
  symbol = '○',
  className = '',
}: EmptyStateProps): ReactElement {
  return (
    <div className={`empty-state ${className}`.trim()}>
      <span className="empty-state-symbol" aria-hidden="true">
        {symbol}
      </span>
      <h3 className="empty-state-title">{title}</h3>
      <p className="empty-state-description">{children}</p>
      {action && <div className="empty-state-action">{action}</div>}
    </div>
  );
}
