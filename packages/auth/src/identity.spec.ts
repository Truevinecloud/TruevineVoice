import { describe, expect, it } from 'vitest';

import { checkEmail, isValidEmail, MAX_EMAIL_LENGTH, normalizeEmail } from './identity.js';

describe('email normalisation', () => {
  it('lowercases and trims so one person cannot hold two accounts', () => {
    expect(normalizeEmail('  Alice.Smith@Example.COM ')).toBe('alice.smith@example.com');
  });

  it('accepts an ordinary address', () => {
    expect(checkEmail('owner@truevinecloud.online')).toEqual({
      ok: true,
      value: 'owner@truevinecloud.online',
    });
  });

  it('accepts plus-addressing and subdomain labels', () => {
    expect(isValidEmail('ops+billing@mail.corp.example.co.ug')).toBe(true);
  });

  it('rejects an empty value', () => {
    expect(checkEmail('   ')).toEqual({ ok: false, problem: 'empty' });
  });

  it('rejects an address with no @', () => {
    expect(checkEmail('alice.example.com')).toEqual({ ok: false, problem: 'malformed' });
  });

  it('rejects an address with no local part', () => {
    expect(checkEmail('@example.com')).toEqual({ ok: false, problem: 'local_part_too_long' });
  });

  it('rejects an address with no domain', () => {
    // The local part is fine; there is simply nothing after the @.
    expect(checkEmail('alice@')).toEqual({ ok: false, problem: 'malformed' });
  });

  it('rejects whitespace inside the address', () => {
    expect(checkEmail('ali ce@example.com')).toEqual({ ok: false, problem: 'malformed' });
  });

  it('rejects more than one @', () => {
    expect(checkEmail('a@b@example.com')).toEqual({ ok: false, problem: 'malformed' });
  });

  it('rejects a local part longer than RFC 5321 allows', () => {
    expect(checkEmail(`${'a'.repeat(65)}@example.com`)).toEqual({
      ok: false,
      problem: 'local_part_too_long',
    });
  });

  it('rejects an address longer than the SMTP maximum', () => {
    const long = `${'a'.repeat(60)}@${'b'.repeat(MAX_EMAIL_LENGTH)}.example.com`;

    expect(checkEmail(long)).toEqual({ ok: false, problem: 'too_long' });
  });

  it('never echoes the rejected value back to the caller', () => {
    // The problem code is all the transport layer gets, so a validation error
    // cannot become a reflected-value leak in a log line.
    const result = checkEmail('not an email');

    expect(JSON.stringify(result)).not.toContain('not an email');
  });
});
