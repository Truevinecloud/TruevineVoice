/**
 * Button — accessible button component.
 *
 * Variants: primary, secondary, danger, ghost.
 * Size: default, small.
 * Disabled state prevents interaction and applies disabled styling.
 * Focus-visible outline uses the app's focus token.
 */

import type { ReactElement } from 'react';

export interface ButtonProps {
  readonly type?: 'button' | 'submit' | 'reset';
  readonly variant?: 'primary' | 'secondary' | 'danger' | 'ghost';
  readonly size?: 'default' | 'small';
  readonly disabled?: boolean;
  readonly onClick?: () => void;
  readonly children: React.ReactNode;
  readonly className?: string;
}

export function Button({
  type = 'button',
  variant = 'secondary',
  size = 'default',
  disabled = false,
  onClick,
  children,
  className = '',
}: ButtonProps): ReactElement {
  return (
    <button
      type={type}
      className={`button button--${variant} button--${size} ${className}`.trim()}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  );
}
