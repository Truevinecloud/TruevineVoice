import { createHash } from 'node:crypto';

import { BadRequestException } from '@nestjs/common';

import type { ParsedContactRow } from './contact.store.js';

export const MAX_IMPORT_BATCH_BYTES = 256 * 1024;
export const MAX_IMPORT_BATCH_ROWS = 250;
const MAX_COLUMNS = 20;
const MAX_GROUPS_PER_ROW = 20;

export const IMPORT_FIELDS = ['phone', 'name', 'email', 'groups', 'consent', 'suppressed'] as const;
export type ImportField = (typeof IMPORT_FIELDS)[number];
export type ColumnMapping = Partial<Record<ImportField, string>>;

const HEADER_ALIASES: Readonly<Record<ImportField, readonly string[]>> = {
  phone: ['phone', 'phone_number', 'mobile', 'mobile_number', 'msisdn'],
  name: ['name', 'full_name'],
  email: ['email', 'email_address'],
  groups: ['groups', 'group'],
  consent: ['consent', 'voice_consent'],
  suppressed: ['suppressed', 'do_not_contact', 'opt_out'],
};

function invalid(message: string): never {
  throw new BadRequestException({ error: { code: 'invalid_contact_import', message } });
}

export function importPayloadHash(csv: string): string {
  return createHash('sha256').update(csv, 'utf8').digest('hex');
}

function parseCsv(source: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let afterQuote = false;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index] as string;

    if (quoted) {
      if (character === '"') {
        if (source[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
          afterQuote = true;
        }
      } else {
        field += character;
      }
      continue;
    }

    if (afterQuote && character !== ',' && character !== '\r' && character !== '\n') {
      invalid('Unexpected text follows a quoted CSV value.');
    }

    if (character === '"') {
      if (field.length !== 0 || afterQuote) invalid('Unexpected quote in CSV value.');
      quoted = true;
    } else if (character === ',') {
      row.push(field);
      field = '';
      afterQuote = false;
    } else if (character === '\r' || character === '\n') {
      if (character === '\r' && source[index + 1] === '\n') index += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      afterQuote = false;
    } else {
      field += character;
    }
  }

  if (quoted) invalid('CSV contains an unterminated quoted value.');
  if (field.length > 0 || row.length > 0 || afterQuote) {
    row.push(field);
    rows.push(row);
  }

  while (rows.length > 0 && (rows.at(-1) ?? []).every((value) => value.trim() === '')) rows.pop();

  if (rows.length < 2) invalid('CSV must include a header and at least one data row.');
  return rows;
}

function normalizeHeader(value: string): string {
  return value
    .replace(/^\uFEFF/, '')
    .trim()
    .toLocaleLowerCase('en-US')
    .replace(/[\s-]+/g, '_');
}

function resolveColumns(
  headers: readonly string[],
  mapping: ColumnMapping,
): Partial<Record<ImportField, number>> {
  const normalizedHeaders = headers.map(normalizeHeader);
  if (normalizedHeaders.length > MAX_COLUMNS || normalizedHeaders.some((header) => !header)) {
    invalid(`CSV must contain between 1 and ${MAX_COLUMNS} named columns.`);
  }
  if (new Set(normalizedHeaders).size !== normalizedHeaders.length) {
    invalid('CSV column names must be unique.');
  }

  const result: Partial<Record<ImportField, number>> = {};
  const chosen = new Set<number>();

  for (const field of IMPORT_FIELDS) {
    const requestedHeader = mapping[field];
    const candidates = requestedHeader ? [normalizeHeader(requestedHeader)] : HEADER_ALIASES[field];
    const column = normalizedHeaders.findIndex((header) => candidates.includes(header));

    if (column >= 0) {
      if (chosen.has(column)) invalid('Each CSV column may map to only one contact field.');
      result[field] = column;
      chosen.add(column);
    } else if (field === 'phone') {
      invalid('A phone column is required. Map a CSV column to phone.');
    } else if (requestedHeader) {
      invalid(`The mapped ${field} column is missing from this CSV batch.`);
    }
  }

  return result;
}

/** Uganda-local phone inputs are converted to E.164; international E.164 is retained. */
export function normalizePhoneE164(value: string): string | undefined {
  let compact = value.trim().replace(/[\s().-]/g, '');
  if (compact.startsWith('00')) compact = `+${compact.slice(2)}`;
  if (/^0\d{9}$/.test(compact)) compact = `+256${compact.slice(1)}`;
  else if (/^256\d{9}$/.test(compact)) compact = `+${compact}`;

  if (!/^\+[1-9]\d{7,14}$/.test(compact)) return undefined;
  if (compact.startsWith('+256') && !/^\+256[27]\d{8}$/.test(compact)) return undefined;
  return compact;
}

function textAt(row: readonly string[], column: number | undefined): string | undefined {
  if (column === undefined) return undefined;
  const value = (row[column] ?? '').trim();
  return value === '' ? undefined : value;
}

function parseSuppression(value: string | undefined): { suppressed: boolean; warning?: string } {
  if (!value) return { suppressed: false };
  const normalized = value.trim().toLocaleLowerCase('en-US');
  if (
    [
      'yes',
      'true',
      '1',
      'suppressed',
      'opt_out',
      'opted_out',
      'unsubscribed',
      'do_not_contact',
    ].includes(normalized)
  ) {
    return { suppressed: true };
  }
  if (['no', 'false', '0', 'active', 'allowed', ''].includes(normalized))
    return { suppressed: false };
  return { suppressed: false, warning: 'unrecognized_suppression_value' };
}

function consentWarnings(value: string | undefined): { suppress: boolean; warnings: string[] } {
  if (!value) return { suppress: false, warnings: [] };
  const normalized = value.trim().toLocaleLowerCase('en-US');
  if (['yes', 'true', '1', 'consented', 'opted_in', 'granted'].includes(normalized)) {
    return { suppress: false, warnings: ['consent_not_granted_from_import'] };
  }
  if (['opted_out', 'unsubscribed', 'do_not_contact'].includes(normalized)) {
    return { suppress: true, warnings: [] };
  }
  if (['no', 'false', '0', 'unknown', 'not_consented', ''].includes(normalized)) {
    return { suppress: false, warnings: [] };
  }
  return { suppress: false, warnings: ['unrecognized_consent_value'] };
}

function normalizeGroupName(value: string): { name: string; normalizedName: string } | undefined {
  const name = value.trim().replace(/\s+/g, ' ');
  if (!name) return undefined;
  if (name.length > 120) return undefined;
  return { name, normalizedName: name.toLocaleLowerCase('en-US') };
}

export interface ParsedImportBatch {
  readonly rows: readonly ParsedContactRow[];
  readonly resolvedMapping: Readonly<Record<string, string>>;
}

export function parseContactImportBatch(csv: string, mapping: ColumnMapping): ParsedImportBatch {
  if (Buffer.byteLength(csv, 'utf8') > MAX_IMPORT_BATCH_BYTES) {
    invalid(`Each CSV batch must be at most ${MAX_IMPORT_BATCH_BYTES} bytes.`);
  }
  const rawRows = parseCsv(csv);
  const headers = rawRows[0] as string[];
  const columns = resolveColumns(headers, mapping);
  const resolvedMapping: Record<string, string> = {};

  for (const field of IMPORT_FIELDS) {
    const column = columns[field];
    if (column !== undefined) resolvedMapping[field] = normalizeHeader(headers[column] as string);
  }

  const dataRows = rawRows.slice(1);
  if (dataRows.length > MAX_IMPORT_BATCH_ROWS) {
    invalid(`Each CSV batch may contain at most ${MAX_IMPORT_BATCH_ROWS} data rows.`);
  }

  const seenPhones = new Set<string>();
  const rows: ParsedContactRow[] = dataRows.map((cells, index) => {
    const rowNumber = index + 2;
    const warnings: string[] = [];
    if (cells.length !== headers.length) {
      return {
        rowNumber,
        groups: [],
        applySuppression: false,
        warningCodes: warnings,
        rejectionCode: 'column_count_mismatch',
      };
    }

    const phoneText = textAt(cells, columns.phone);
    const phoneE164 = phoneText ? normalizePhoneE164(phoneText) : undefined;
    if (!phoneE164) {
      return {
        rowNumber,
        groups: [],
        applySuppression: false,
        warningCodes: warnings,
        rejectionCode: 'invalid_phone',
      };
    }
    if (seenPhones.has(phoneE164)) {
      return {
        rowNumber,
        phoneE164,
        groups: [],
        applySuppression: false,
        warningCodes: warnings,
        rejectionCode: 'duplicate_phone_in_batch',
      };
    }
    seenPhones.add(phoneE164);

    const name = textAt(cells, columns.name);
    const email = textAt(cells, columns.email);
    let rejectionCode: string | undefined;
    if (name && name.length > 200) rejectionCode = 'name_too_long';
    if (email && (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) {
      rejectionCode = 'invalid_email';
    }

    const groupsText = textAt(cells, columns.groups);
    const rawGroups = groupsText ? groupsText.split(/[;|]/) : [];
    const groups = new Map<string, { name: string; normalizedName: string }>();
    for (const rawGroup of rawGroups) {
      const group = normalizeGroupName(rawGroup);
      if (!group) {
        warnings.push('invalid_group_name');
      } else {
        groups.set(group.normalizedName, group);
      }
    }
    if (groups.size > MAX_GROUPS_PER_ROW) rejectionCode = 'too_many_groups';

    const suppression = parseSuppression(textAt(cells, columns.suppressed));
    if (suppression.warning) warnings.push(suppression.warning);
    const consent = consentWarnings(textAt(cells, columns.consent));

    return {
      rowNumber,
      phoneE164,
      name,
      email,
      groups: [...groups.values()],
      applySuppression: suppression.suppressed || consent.suppress,
      warningCodes: [...warnings, ...consent.warnings],
      rejectionCode,
    };
  });

  return { rows, resolvedMapping };
}
