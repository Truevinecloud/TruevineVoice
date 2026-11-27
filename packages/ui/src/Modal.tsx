/**
 * Modal — accessible modal dialog.
 *
 * Renders a backdrop and a dialog container. Focus management, escape key
 * handling and click-to-close on backdrop are the responsibility of the
 * consuming application; this component provides the structure and ARIA
 * attributes.
 */

import type { ReactElement } from 'react';

export interface ModalProps {
  readonly isOpen: boolean;
  readonly title: string;
  readonly onClose: () => void;
  readonly children: React.ReactNode;
  readonly className?: string;
}

export function Modal({
  isOpen,
  title,
  onClose,
  children,
  className = '',
}: ModalProps): ReactElement {
  if (!isOpen) {
    return <></>;
  }

  return (
    <div
      className={`modal-overlay ${className}`.trim()}
      role="dialog"
      aria-modal="true"
      aria-labelledby="modal-title"
    >
      <div className="modal">
        <div className="modal-header">
          <h2 id="modal-title" className="modal-title">
            {title}
          </h2>
          <button
            type="button"
            className="modal-close"
            onClick={onClose}
            aria-label="Close dialog"
          >
            ×
          </button>
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}
