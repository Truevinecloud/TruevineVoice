import { describe, expect, it } from 'vitest';

import {
  PhoneNumberError,
  countryCallingCode,
  isPhoneNumber,
  parsePhoneNumber,
} from './phone-number.js';

describe('phone number — E.164 validation', () => {
  it('accepts a valid Ugandan E.164 number', () => {
    const number = parsePhoneNumber('+256772123456');
    expect(number).toBe('+256772123456');
  });

  it('trims surrounding whitespace', () => {
    expect(parsePhoneNumber('  +256772123456  ')).toBe('+256772123456');
  });

  it('rejects a number without the leading plus', () => {
    expect(() => parsePhoneNumber('256772123456')).toThrow(PhoneNumberError);
  });

  it('rejects a leading zero country code', () => {
    expect(() => parsePhoneNumber('+0256772123456')).toThrow(PhoneNumberError);
  });

  it('rejects spaces, hyphens and parentheses', () => {
    expect(() => parsePhoneNumber('+256 772 123 456')).toThrow(PhoneNumberError);
    expect(() => parsePhoneNumber('+256-772-123456')).toThrow(PhoneNumberError);
    expect(() => parsePhoneNumber('(+256)772123456')).toThrow(PhoneNumberError);
  });

  it('rejects more than 15 digits', () => {
    expect(() => parsePhoneNumber('+1234567890123456')).toThrow(PhoneNumberError);
  });

  it('accepts the maximum of 15 digits', () => {
    expect(() => parsePhoneNumber('+123456789012345')).not.toThrow();
  });

  it('rejects an empty string', () => {
    expect(() => parsePhoneNumber('')).toThrow(PhoneNumberError);
  });

  it('isPhoneNumber mirrors the parse result without throwing', () => {
    expect(isPhoneNumber('+256772123456')).toBe(true);
    expect(isPhoneNumber('0721234567')).toBe(false);
  });

  it('derives the country calling code prefix', () => {
    expect(countryCallingCode(parsePhoneNumber('+256772123456'))).toBe('256');
  });
});
