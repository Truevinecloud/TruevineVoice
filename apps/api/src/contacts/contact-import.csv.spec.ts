import { describe, expect, it } from 'vitest';

import { normalizePhoneE164, parseContactImportBatch } from './contact-import.csv.js';

describe('contact CSV import', () => {
  it('normalizes Uganda local and international numbers to E.164', () => {
    expect(normalizePhoneE164('0772 123 456')).toBe('+256772123456');
    expect(normalizePhoneE164('00256772123456')).toBe('+256772123456');
    expect(normalizePhoneE164('+12025550123')).toBe('+12025550123');
    expect(normalizePhoneE164('123')).toBeUndefined();
  });

  it('reports consent claims without granting consent and treats opt-out as suppression', () => {
    const parsed = parseContactImportBatch(
      'Mobile,Name,Groups,Consent,Opt Out\n0772123456,Ada,Customers,yes,false\n0772123457,Sam,Customers,,true',
      {},
    );
    expect(parsed.rows[0]).toMatchObject({
      phoneE164: '+256772123456',
      warningCodes: ['consent_not_granted_from_import'],
      applySuppression: false,
    });
    expect(parsed.rows[1]).toMatchObject({ phoneE164: '+256772123457', applySuppression: true });
  });

  it('rejects duplicate normalized phones and malformed quoting', () => {
    const parsed = parseContactImportBatch('phone,name\n0772123456,Ada\n+256772123456,Other', {});
    expect(parsed.rows[1]?.rejectionCode).toBe('duplicate_phone_in_batch');
    expect(() => parseContactImportBatch('phone,name\n0772123456,"Ada', {})).toThrow();
  });
});
