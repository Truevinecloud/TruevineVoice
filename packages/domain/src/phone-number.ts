/**
 * A telephone number in E.164 form.
 *
 * ARCHITECTURAL RULES ENFORCED HERE
 * ---------------------------------
 * - A number that will be dialled and charged must be normalised and validated
 *   before it reaches an adapter. E.164 is that normal form: a `+`, a country
 *   code, and a national number, with no spaces, hyphens or parentheses.
 * - This module performs no I/O and imports no provider SDK. Whether a country
 *   code is *dialable by the provider* is the adapter's concern; whether the
 *   string is well-formed E.164 is this module's concern.
 */

/** E.164: `+` then a non-zero leading digit and up to 15 digits total. */
const E164_PATTERN = /^\+[1-9]\d{0,14}$/;

/** The maximum number of digits in an E.164 number, excluding the `+`. */
export const E164_MAX_DIGITS = 15;

/** Raised when a value is not a valid E.164 number. */
export class PhoneNumberError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PhoneNumberError';
  }
}

/**
 * A validated E.164 phone number.
 *
 * Construct via `parsePhoneNumber`; the brand prevents an arbitrary string from
 * being treated as one.
 */
export type PhoneNumber = string & { readonly __brand: 'PhoneNumber' };

/**
 * Parses and validates a string as E.164.
 *
 * Surrounding whitespace is trimmed; every other deviation is rejected rather
 * than silently repaired, because a "repaired" number that is wrong is a call
 * to a stranger.
 */
export function parsePhoneNumber(input: string): PhoneNumber {
  if (typeof input !== 'string') {
    throw new PhoneNumberError('Phone number must be a string.');
  }
  const candidate = input.trim();
  if (!E164_PATTERN.test(candidate)) {
    throw new PhoneNumberError(
      `"${input}" is not a valid E.164 number (expected + followed by up to ${E164_MAX_DIGITS} digits).`,
    );
  }
  return candidate as PhoneNumber;
}

/** True when the string is valid E.164, without throwing. */
export function isPhoneNumber(input: string): boolean {
  return typeof input === 'string' && E164_PATTERN.test(input.trim());
}

/** Returns the country calling code without the `+`, e.g. `256` for Uganda. */
export function countryCallingCode(number: PhoneNumber): string {
  // E.164 country codes are 1-3 digits. Without a full numbering-plan table the
  // honest answer for a *derived* code is out of scope, so this returns the
  // leading digits up to three and callers that need exact resolution must use a
  // numbering-plan source. Kept deliberately simple and documented.
  return number.slice(1, 4);
}
