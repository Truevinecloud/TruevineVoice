/**
 * Email normalisation and validation.
 *
 * Email is the initial login identifier. The database stores the normalised
 * form only, with a CHECK constraint requiring `email = lower(email)`, so
 * uniqueness is exact and `Alice@x.com` cannot become a second account for
 * `alice@x.com`.
 */

/** Maximum length, matching the practical SMTP limit. */
export const MAX_EMAIL_LENGTH = 320;

/** Maximum length of a local part, per RFC 5321. */
const MAX_LOCAL_PART_LENGTH = 64;

/**
 * Deliberately permissive.
 *
 * A strict RFC 5322 parser rejects addresses that deliver mail. This only
 * rejects shapes that cannot be an address at all, and leaves deliverability to
 * the confirmation email rather than to a regular expression.
 */
const EMAIL_SHAPE = /^[^\s@,;:<>"'()[\]\\]+@[^\s@,;:<>"'()[\]\\]+$/;

/** Why an email was rejected. Never includes the rejected value. */
export type EmailProblem = 'empty' | 'too_long' | 'local_part_too_long' | 'malformed';

/** The result of normalising an email. */
export type EmailCheck =
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly problem: EmailProblem };

/**
 * Normalises an email for storage and comparison.
 *
 * Trims surrounding whitespace and lowercases the whole address. The local part
 * is technically case-sensitive per RFC 5321, but in practice no major provider
 * treats it that way, and treating two spellings as different accounts is a
 * support burden and a way to impersonate an existing user.
 */
export function checkEmail(input: string): EmailCheck {
  const value = input.trim().toLowerCase();

  if (value.length === 0) return { ok: false, problem: 'empty' };
  if (value.length > MAX_EMAIL_LENGTH) return { ok: false, problem: 'too_long' };

  const separator = value.lastIndexOf('@');
  const localPart = value.slice(0, separator);
  if (localPart.length === 0 || localPart.length > MAX_LOCAL_PART_LENGTH) {
    return { ok: false, problem: 'local_part_too_long' };
  }

  return EMAIL_SHAPE.test(value) ? { ok: true, value } : { ok: false, problem: 'malformed' };
}

/** Normalised email, or `undefined` when the input is not an address. */
export function normalizeEmail(input: string): string | undefined {
  const result = checkEmail(input);
  return result.ok ? result.value : undefined;
}

/** Whether the input normalises to an address. */
export function isValidEmail(input: string): boolean {
  return checkEmail(input).ok;
}
