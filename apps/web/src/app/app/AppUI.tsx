import type { ReactNode } from 'react';

export function PageHeader({
  title,
  description,
  eyebrow,
  actions,
}: {
  readonly title: string;
  readonly description?: string;
  readonly eyebrow?: string;
  readonly actions?: ReactNode;
}): React.JSX.Element {
  return (
    <header className="page-header">
      <div className="page-header__copy">
        {eyebrow && <p className="page-eyebrow">{eyebrow}</p>}
        <h1 className="page-title">{title}</h1>
        {description && <p className="page-description">{description}</p>}
      </div>
      {actions && <div className="page-header__actions">{actions}</div>}
    </header>
  );
}

export function SectionCard({
  title,
  description,
  actions,
  children,
  className = '',
}: {
  readonly title?: string;
  readonly description?: string;
  readonly actions?: ReactNode;
  readonly children: ReactNode;
  readonly className?: string;
}): React.JSX.Element {
  return (
    <section className={`card-section ${className}`.trim()}>
      {(title || description || actions) && (
        <header className="card-section__header">
          <div>
            {title && <h2>{title}</h2>}
            {description && <p className="field-hint">{description}</p>}
          </div>
          {actions && <div className="card-section__actions">{actions}</div>}
        </header>
      )}
      {children}
    </section>
  );
}

export function EmptyState({
  title,
  children,
  action,
}: {
  readonly title: string;
  readonly children: ReactNode;
  readonly action?: ReactNode;
}): React.JSX.Element {
  return (
    <div className="empty-state">
      <span className="empty-state__symbol" aria-hidden="true">
        ○
      </span>
      <h3>{title}</h3>
      <p>{children}</p>
      {action && <div className="empty-state__action">{action}</div>}
    </div>
  );
}

export function StatusBadge({
  children,
  tone = 'neutral',
}: {
  readonly children: ReactNode;
  readonly tone?: 'neutral' | 'success' | 'warning' | 'danger' | 'info';
}): React.JSX.Element {
  return <span className={`status-badge status-badge--${tone}`}>{children}</span>;
}
