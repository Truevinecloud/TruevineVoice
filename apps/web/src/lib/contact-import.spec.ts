import { describe, expect, it } from 'vitest';

import {
  MAX_IMPORT_BATCH_ROWS,
  importWarningLabel,
  splitCsvBatches,
  splitCsvRows,
  summariseImport,
} from './contact-import';

describe('contact import batching', () => {
  it('keeps quoted commas and newlines inside one row', () => {
    const rows = splitCsvRows('phone,name\n+256772000001,"Ada, Lovelace"\n+256772000002,"Line\nbreak"');

    expect(rows).toEqual([
      'phone,name',
      '+256772000001,"Ada, Lovelace"',
      '+256772000002,"Line\nbreak"',
    ]);
    expect(splitCsvBatches(rows.join('\n')).dataRows).toBe(2);
  });

  it('splits at the API row limit and repeats the header', () => {
    const data = Array.from({ length: MAX_IMPORT_BATCH_ROWS + 3 }, (_, index) => `+2567720${String(index).padStart(5, '0')}`);
    const csv = ['phone', ...data].join('\n');

    const result = splitCsvBatches(csv);

    expect(result.dataRows).toBe(MAX_IMPORT_BATCH_ROWS + 3);
    expect(result.batches).toHaveLength(2);
    for (const batch of result.batches) {
      const lines = batch.split('\n');
      expect(lines[0]).toBe('phone');
      expect(lines.length).toBeLessThanOrEqual(MAX_IMPORT_BATCH_ROWS + 1);
    }
    expect(result.batches[1]!.split('\n')).toHaveLength(4);
  });

  it('splits on the byte limit before the row limit', () => {
    const csv = ['phone,note', '+1,aaaaaaaaaa', '+2,bbbbbbbbbb', '+3,cccccccccc'].join('\n');

    const result = splitCsvBatches(csv, { maxBytes: 30 });

    expect(result.batches.length).toBeGreaterThan(1);
    for (const batch of result.batches) {
      expect(new TextEncoder().encode(batch).length).toBeLessThanOrEqual(30);
      expect(batch.split('\n')[0]).toBe('phone,note');
    }
  });

  it('rejects a file without data, an unterminated quote, or an oversized row', () => {
    expect(() => splitCsvBatches('phone')).toThrow(/no contact rows/i);
    expect(() => splitCsvBatches('')).toThrow(/no header row/i);
    expect(() => splitCsvRows('phone\n"+1')).toThrow(/unterminated/i);
    expect(() =>
      splitCsvBatches('phone\n+1,aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', { maxBytes: 20 }),
    ).toThrow(/single contact row is too large/i);
  });

  it('strips a byte-order mark from the header', () => {
    const result = splitCsvBatches('\uFEFFphone,name\n+256772000001,Ada');

    expect(result.header).toBe('phone,name');
  });

  it('explains known warning codes and summarizes a completed import', () => {
    expect(importWarningLabel('consent_not_granted_from_import')).toContain(
      'never records voice consent',
    );
    expect(importWarningLabel('unknown_code')).toContain('server reported');

    expect(
      summariseImport({
        importId: 'import-1',
        status: 'COMPLETED',
        nextBatchNumber: 1,
        rowsProcessed: 10,
        created: 6,
        updated: 2,
        unchanged: 1,
        rejected: 1,
        warnings: 3,
        createdAt: '2026-10-27T00:00:00.000Z',
        completedAt: '2026-10-27T00:01:00.000Z',
      }),
    ).toBe('10 rows processed, 6 created, 2 updated, 1 unchanged, 1 rejected, 3 warnings');
  });
});
