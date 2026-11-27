/**
 * Input — accessible text input component.
 *
 * Links a visible <label> to the <input> via id. Supports placeholder,
 * maxLength, required and disabled states. Focus-visible outline uses the
 * app's focus token.
 */

import type { ReactElement } from 'react';

export interface InputProps {
  readonly id: string;
  readonly type?: 'text' | 'email' | 'tel' | 'password' | 'number' | 'url';
  readonly value: string;
  readonly onChange: (event: React.ChangeEvent<HTMLInputElement>) => void;
  readonly placeholder?: string;
  readonly maxLength?: number;
  readonly required?: boolean;
  readonly disabled?: boolean;
  readonly label?: string;
  readonly hint?: string;
  readonly error?: string;
  readonly className?: string;
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
  label,
  hint,
  error,
  className = '',
}: InputProps): ReactElement {
  return (
    <div className={`input-field ${className}`.trim()}>
      {label && <label htmlFor={id} className="input-label">{label}</label>}
      <input
        id={id}
        type={type}
        value={value}
        onChange={onChange}
        placeholder={placeholder}
        maxLength={maxLength}
        required={required}
        disabled={disabled}
        className="input"
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-error` : undefined}
      />
      {hint && <p id={`${id}-hint`} className="input-hint">{hint}</p>}
      {error && <p id={`${id}-error`} className="input-error" role="alert">{error}</p>}
    </div>
  );
}
