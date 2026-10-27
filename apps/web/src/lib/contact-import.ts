/**
 * Browser-side preparation for the resumable contact import API.
 *
 * The API accepts at most 250 data rows and 256 KiB per batch, and every batch
 * must repeat the header row. Splitting here keeps that contract in one place
 * instead of scattering magic numbers through a component.
 *
 * Nothing in this module decides which contacts are eligible, whether consent
 * was granted, or whether a contact may be called. The server owns those rules;
 * the import API in particular records that a CSV "consented" value is **not**
 * consent evidence.
 */

export const MAX_IMPORT_BATCH_ROWS = 250;
export const MAX_IMPORT_BATCH_BYTES = 256 * 1024;

/** The API's import summary. */
export interface ContactImportSummary {
  readonly importId: string;
  readonly status: 'OPEN' | 'COMPLETED';
  readonly nextBatchNumber: number;
  readonly rowsProcessed: number;
  readonly created: number;
  readonly updated: number;
  readonly unchanged: number;
  readonly rejected: number;
  readonly warnings: number;
  readonly createdAt: string;
  readonly completedAt: string | null;
}

export interface ContactImportBatchResult {
  readonly rows: readonly {
    readonly rowNumber: number;
    readonly outcome: 'CREATED' | 'UPDATED' | 'UNCHANGED' | 'REJECTED';
    readonly code?: string;
    readonly warningCodes: readonly string[];
  }[];
  readonly summary: ContactImportSummary;
}

/**
 * Splits CSV text into raw rows while respecting quoted fields and quoted
 * newlines. The returned rows keep their original quoting so a batch can be
 * sent back without re-encoding.
 */
export function splitCsvRows(text: string): string[] {
  const rows: string[] = [];
  let row = '';
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index] as string;

    if (character === '"') {
      // A doubled quote inside a quoted field is an escaped quote, not the end
      // of the field.
      if (quoted && text[index + 1] === '"') {
        row += '""';
        index += 1;
        continue;
      }
      quoted = !quoted;
      row += character;
      continue;
    }

    if (!quoted && (character === '\n' || character === '\r')) {
      if (character === '\r' && text[index + 1] === '\n') index += 1;
      rows.push(row);
      row = '';
      continue;
    }

    row += character;
  }

  if (quoted) throw new Error('The CSV has an unterminated quoted value.');
  if (row.length > 0) rows.push(row);

  // Trailing blank lines are not data rows.
  while (rows.length > 0 && (rows.at(-1) ?? '').trim() === '') rows.pop();
  return rows;
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

export interface ContactImportBatches {
  /** The header row, repeated on every batch. */
  readonly header: string;
  /** Batches of `header + data rows`, each within the API limits. */
  readonly batches: readonly string[];
  readonly dataRows: number;
}

/**
 * Splits a CSV file into API-sized batches.
 *
 * A file with no data row is rejected here rather than after a round trip, and
 * a single row too large for one batch is reported instead of being silently
 * truncated.
 */
export function splitCsvBatches(
  text: string,
  limits: { readonly maxRows?: number; readonly maxBytes?: number } = {},
): ContactImportBatches {
  const maxRows = limits.maxRows ?? MAX_IMPORT_BATCH_ROWS;
  const maxBytes = limits.maxBytes ?? MAX_IMPORT_BATCH_BYTES;
  const rows = splitCsvRows(text.replace(/^\uFEFF/, ''));

  if (rows.length === 0 || (rows[0] ?? '').trim() === '') {
    throw new Error('The file has no header row. Export contacts as CSV with a phone column.');
  }

  const header = rows[0] as string;
  const dataRows = rows.slice(1);
  if (dataRows.length === 0) {
    throw new Error('The file has a header but no contact rows.');
  }

  const headerBytes = byteLength(`${header}\n`);
  if (headerBytes > maxBytes) {
    throw new Error('The CSV header is too large for an import batch. Use fewer or shorter columns.');
  }

  const batches: string[] = [];
  let current: string[] = [];
  let currentBytes = headerBytes;

  const flush = (): void => {
    if (current.length === 0) return;
    batches.push([header, ...current].join('\n'));
    current = [];
    currentBytes = headerBytes;
  };

  for (const row of dataRows) {
    const rowBytes = byteLength(`${row}\n`);

    if (headerBytes + rowBytes > maxBytes) {
      throw new Error(
        'A single contact row is too large for one import batch. Shorten the row and try again.',
      );
    }

    if (current.length >= maxRows || currentBytes + rowBytes > maxBytes) flush();

    current.push(row);
    currentBytes += rowBytes;
  }

  flush();
  return { header, batches, dataRows: dataRows.length };
}

/** Operator-facing explanations for the warning codes the API can return. */
export const IMPORT_WARNING_LABELS: Readonly<Record<string, string>> = {
  consent_not_granted_from_import:
    'A “consented” CSV value never records voice consent. Record consent evidence separately for each contact.',
  unrecognized_consent_value:
    'Some consent values were not recognised. Those rows were imported without adding consent.',
  unrecognized_suppression_value:
    'Some suppression values were not recognised. Those contacts were not suppressed by the value.',
};

export function importWarningLabel(code: string): string {
  return IMPORT_WARNING_LABELS[code] ?? 'The server reported an import warning for this code.';
}

/** A short, safe description of a finished import. */
export function summariseImport(summary: ContactImportSummary): string {
  return [
    `${summary.rowsProcessed} rows processed`,
    `${summary.created} created`,
    `${summary.updated} updated`,
    `${summary.unchanged} unchanged`,
    `${summary.rejected} rejected`,
    `${summary.warnings} warnings`,
  ].join(', ');
}
