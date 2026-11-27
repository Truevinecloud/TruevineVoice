/**
 * Select — accessible select control component.
 *
 * Links a visible <label> to the <select> via id. Options are supplied as
 * { value, label } pairs. Supports disabled state and error messaging.
 */

import type { ReactElement } from 'react';

export interface SelectOption {
  readonly value: string;
  readonly label: string;
}

export interface SelectProps {
  readonly id: string;
  readonly value: string;
  readonly onChange: (event: React.ChangeEvent<HTMLSelectElement>) => void;
  readonly options: readonly SelectOption[];
  readonly disabled?: boolean;
  readonly label?: string;
  readonly hint?: string;
  readonly error?: string;
  readonly className?: string;
}

export function Select({
  id,
  value,
  onChange,
  options,
  disabled,
  label,
  hint,
  error,
  className = '',
}: SelectProps): ReactElement {
  return (
    <div className={`select-field ${className}`.trim()}>
      {label && <label htmlFor={id} className="select-label">{label}</label>}
      <select
        id={id}
        value={value}
        onChange={onChange}
        disabled={disabled}
        className="select"
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-error` : undefined}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      {hint && <p id={`${id}-hint`} className="select-hint">{hint}</p>}
      {error && <p id={`${id}-error`} className="select-error" role="alert">{error}</p>}
    </div>
  );
}
