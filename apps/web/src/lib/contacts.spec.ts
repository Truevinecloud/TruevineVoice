import { describe, expect, it } from 'vitest';

import { isSafeConsentSource } from './contacts';

/**
 * The consent API validates `source` with
 * `/^[A-Za-z0-9][A-Za-z0-9._:-]{2,79}$/`
 * (apps/api/src/contacts/contacts.service.ts). These cases pin the browser-side
 * copy of that rule, including the exact natural-language value the form used to
 * encourage: the form said "signed form or call recording" and accepted it, then
 * the API rejected it.
 */
describe('consent source validation', () => {
  it('accepts the identifiers the consent API accepts', () => {
    for (const value of [
      'signed_form',
      'call-recording',
      'web.form',
      'CRM:2026',
      '  signed_form  ',
    ]) {
      expect(isSafeConsentSource(value)).toBe(true);
    }
  });

  it('rejects natural-language descriptions and malformed identifiers', () => {
    for (const value of [
      'Signed membership form',
      'signed form',
      '',
      '   ',
      'signed/orm',
      'ab',
      'a'.repeat(81),
    ]) {
      expect(isSafeConsentSource(value)).toBe(false);
    }
  });

  it('enforces the 3 and 80 character boundaries and the leading character', () => {
    expect(isSafeConsentSource('abc')).toBe(true);
    expect(isSafeConsentSource('a'.repeat(80))).toBe(true);
    expect(isSafeConsentSource('a'.repeat(81))).toBe(false);
    expect(isSafeConsentSource('_abc')).toBe(false);
    expect(isSafeConsentSource('1abc')).toBe(true);
  });
});
