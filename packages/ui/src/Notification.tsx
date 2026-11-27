/**
 * Notification — non-blocking status message.
 *
 * Variants: success, warning, danger, info. Can be dismissible via an
 * onClose callback. Renders as a <div role="alert">.
 */

import type { ReactElement } from 'react';

export interface NotificationProps {
  readonly children: React.ReactNode;
  readonly variant?: 'success' | 'warning' | 'danger' | 'info';
  readonly onClose?: () => void;
  readonly className?: string;
}

export function Notification({
  children,
  variant = 'info',
  onClose,
  className = '',
}: NotificationProps): ReactElement {
  return (
    <div
      className={`notification notification--${variant} ${className}`.trim()}
      role="alert"
    >
      {children}
      {onClose && (
        <button
          type="button"
          className="notification-close"
          onClick={onClose}
          aria-label="Dismiss notification"
        >
          ×
        </button>
      )}
    </div>
  );
}
