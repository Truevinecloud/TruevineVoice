/**
 * Card — section container with optional title, description and actions.
 *
 * Provides a bordered, padded container with an optional header containing
 * title, description and action area. Children render in the card body.
 */

import type { ReactElement } from 'react';

export interface CardProps {
  readonly title?: string;
  readonly description?: string;
  readonly actions?: React.ReactNode;
  readonly children: React.ReactNode;
  readonly className?: string;
}

export function Card({
  title,
  description,
  actions,
  children,
  className = '',
}: CardProps): ReactElement {
  return (
    <section className={`card ${className}`.trim()}>
      {(title || description || actions) && (
        <header className="card-header">
          <div>
            {title && <h2 className="card-title">{title}</h2>}
            {description && <p className="card-description">{description}</p>}
          </div>
          {actions && <div className="card-actions">{actions}</div>}
        </header>
      )}
      <div className="card-body">{children}</div>
    </section>
  );
}
