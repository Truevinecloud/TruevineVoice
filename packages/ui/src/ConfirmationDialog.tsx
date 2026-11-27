/**
 * ConfirmationDialog — accessible confirmation dialog.
 *
 * Renders a modal with title, message, confirm and cancel buttons. The
 * confirm button can be marked busy and can display an error message.
 */

import type { ReactElement } from 'react';

import { Button } from './Button.js';

export interface ConfirmationDialogProps {
  readonly isOpen: boolean;
  readonly title: string;
  readonly message: string;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
  readonly confirmLabel?: string;
  readonly confirmVariant?: 'primary' | 'danger';
  readonly busy?: boolean;
  readonly error?: string;
  readonly className?: string;
}

export function ConfirmationDialog({
  isOpen,
  title,
  message,
  onConfirm,
  onCancel,
  confirmLabel = 'Confirm',
  confirmVariant = 'primary',
  busy = false,
  error,
  className = '',
}: ConfirmationDialogProps): ReactElement {
  if (!isOpen) {
    return <></>;
  }

  return (
    <div
      className={`confirmation-dialog-overlay ${className}`.trim()}
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirmation-title"
    >
      <div className="confirmation-dialog">
        <h2 id="confirmation-title" className="confirmation-title">
          {title}
        </h2>
        <p className="confirmation-message">{message}</p>
        {error && <p className="confirmation-error" role="alert">{error}</p>}
        <div className="confirmation-actions">
          <Button
            type="button"
            variant="secondary"
            onClick={onCancel}
            disabled={busy}
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant={confirmVariant}
            onClick={onConfirm}
            disabled={busy}
          >
            {busy ? 'Confirming…' : confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
