/**
 * Badge — small status indicator.
 *
 * Variants: neutral, success, warning, danger, info. Renders as a
 * <span> with pill-shaped border radius.
 */

import type { ReactElement } from 'react';

export interface BadgeProps {
  readonly children: React.ReactNode;
  readonly variant?: 'neutral' | 'success' | 'warning' | 'danger' | 'info';
  readonly className?: string;
}

export function Badge({
  children,
  variant = 'neutral',
  className = '',
}: BadgeProps): ReactElement {
  return (
    <span className={`badge badge--${variant} ${className}`.trim()}>
      {children}
    </span>
  );
}
