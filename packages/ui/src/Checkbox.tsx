/**
 * Checkbox — accessible checkbox component.
 *
 * Links a visible <label> to the <input type="checkbox"> via id. Supports
 * checked/unchecked, disabled and error states.
 */

import type { ReactElement } from 'react';

export interface CheckboxProps {
  readonly id: string;
  readonly checked: boolean;
  readonly onChange: (event: React.ChangeEvent<HTMLInputElement>) => void;
  readonly label: string;
  readonly disabled?: boolean;
  readonly error?: string;
  readonly className?: string;
}

export function Checkbox({
  id,
  checked,
  onChange,
  label,
  disabled = false,
  error,
  className = '',
}: CheckboxProps): ReactElement {
  return (
    <div className={`checkbox-field ${className}`.trim()}>
      <input
        id={id}
        type="checkbox"
        checked={checked}
        onChange={onChange}
        disabled={disabled}
        className="checkbox"
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-error` : undefined}
      />
      <label htmlFor={id} className="checkbox-label">{label}</label>
      {error && <p id={`${id}-error`} className="checkbox-error" role="alert">{error}</p>}
    </div>
  );
}
