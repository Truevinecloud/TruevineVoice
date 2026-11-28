import type { CSSProperties, ReactNode } from 'react';

export function OrganizationAccessDenied(): React.JSX.Element {
  return (
    <section className="card workspace-access-state" aria-labelledby="workspace-access-title">
      <span className="status-badge status-badge--warning">Workspace unavailable</span>
      <h1 id="workspace-access-title">Choose an authorized workspace</h1>
      <p role="alert">You do not have access to the selected organization. Your access may have changed.</p>
      <p>Use the workspace selector or return to your dashboard to continue.</p>
      <a className="button-primary" href="/app">Return to my workspace</a>
    </section>
  );
}

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
  style,
}: {
  readonly title?: string;
  readonly description?: string;
  readonly actions?: ReactNode;
  readonly children: ReactNode;
  readonly className?: string;
  readonly style?: CSSProperties;
}): React.JSX.Element {
  return (
    <section className={`card-section ${className}`.trim()} style={style}>
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

export function Tag({
  children,
  variant = 'neutral',
}: {
  readonly children: ReactNode;
  readonly variant?: 'neutral' | 'system' | 'custom';
}): React.JSX.Element {
  return <span className={`tag tag--${variant}`}>{children}</span>;
}

export function ConfirmDialog({
  title,
  message,
  confirmLabel = 'Confirm',
  confirmVariant = 'primary',
  busy = false,
  error,
  onConfirm,
  onCancel,
}: {
  readonly title: string;
  readonly message: ReactNode;
  readonly confirmLabel?: string;
  readonly confirmVariant?: 'primary' | 'secondary' | 'danger';
  readonly busy?: boolean;
  readonly error?: string;
  readonly onConfirm: () => void | Promise<void>;
  readonly onCancel: () => void;
}): React.JSX.Element {
  return (
    <div className="dialog-backdrop" role="presentation">
      <section className="dialog" role="dialog" aria-modal="true" aria-labelledby="confirm-dialog-title">
        <h2 id="confirm-dialog-title">{title}</h2>
        <p>{message}</p>
        {error && <p className="notice notice-error" role="alert">{error}</p>}
        <div className="dialog__actions">
          <Button variant="secondary" disabled={busy} onClick={onCancel}>
            Cancel
          </Button>
          <Button variant={confirmVariant} disabled={busy} onClick={() => void onConfirm()}>
            {confirmLabel}
          </Button>
        </div>
      </section>
    </div>
  );
}

export function Button({
  children,
  disabled = false,
  onClick,
  type = 'button',
  variant = 'primary',
}: {
  readonly children: ReactNode;
  readonly disabled?: boolean;
  readonly onClick?: () => void;
  readonly type?: 'button' | 'submit' | 'reset';
  readonly variant?: 'primary' | 'secondary' | 'danger';
}): React.JSX.Element {
  return (
    <button
      className={`button-${variant}`}
      disabled={disabled}
      onClick={onClick}
      type={type}
    >
      {children}
    </button>
  );
}

export function Input({
  id,
  type = 'text',
  value,
  onChange,
  placeholder,
  maxLength,
  required,
  disabled,
}: {
  readonly id: string;
  readonly type?: string;
  readonly value: string;
  readonly onChange: (event: React.ChangeEvent<HTMLInputElement>) => void;
  readonly placeholder?: string;
  readonly maxLength?: number;
  readonly required?: boolean;
  readonly disabled?: boolean;
}): React.JSX.Element {
  return (
    <input
      id={id}
      className="input"
      type={type}
      value={value}
      onChange={onChange}
      placeholder={placeholder}
      maxLength={maxLength}
      required={required}
      disabled={disabled}
    />
  );
}

export function Textarea({
  id,
  value,
  onChange,
  placeholder,
  rows,
  disabled,
}: {
  readonly id: string;
  readonly value: string;
  readonly onChange: (event: React.ChangeEvent<HTMLTextAreaElement>) => void;
  readonly placeholder?: string;
  readonly rows?: number;
  readonly disabled?: boolean;
}): React.JSX.Element {
  return (
    <textarea
      id={id}
      className="textarea"
      value={value}
      onChange={onChange}
      placeholder={placeholder}
      rows={rows}
      disabled={disabled}
    />
  );
}
