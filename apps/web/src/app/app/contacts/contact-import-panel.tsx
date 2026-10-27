'use client';

import { useRef, useState } from 'react';

import { messageFor, request } from '../../../lib/api';
import {
  MAX_IMPORT_BATCH_BYTES,
  MAX_IMPORT_BATCH_ROWS,
  splitCsvBatches,
  summariseImport,
  type ContactImportBatchResult,
  type ContactImportSummary,
} from '../../../lib/contact-import';

type Step = 'choose' | 'review' | 'running' | 'done';

/**
 * Smallest safe CSV import surface.
 *
 * The browser only splits the file and drives the API's resumable import. It
 * never decides eligibility, never records consent, and never writes a contact
 * directly. A CSV consent column is explicitly described as *not* consent
 * evidence, because the server reports exactly that as a warning.
 */
export function ContactImportPanel({
  organizationId,
  onImported,
}: {
  readonly organizationId: string;
  readonly onImported: () => void;
}): React.JSX.Element {
  const [step, setStep] = useState<Step>('choose');
  const [fileName, setFileName] = useState('');
  const [fileText, setFileText] = useState('');
  const [dataRows, setDataRows] = useState(0);
  const [batchCount, setBatchCount] = useState(0);
  const [processedBatches, setProcessedBatches] = useState(0);
  /**
   * The API's resumable import id. A retry after a failed batch must reuse it,
   * because the same import can only accept each batch number once and the
   * earlier batches already changed contact records.
   */
  const [startedImportId, setStartedImportId] = useState<string | null>(null);
  const [summary, setSummary] = useState<ContactImportSummary | null>(null);
  const [error, setError] = useState('');
  const input = useRef<HTMLInputElement>(null);

  function clear(): void {
    setStep('choose');
    setFileName('');
    setFileText('');
    setDataRows(0);
    setBatchCount(0);
    setProcessedBatches(0);
    setStartedImportId(null);
    setSummary(null);
    setError('');
    if (input.current) input.current.value = '';
  }

  async function review(file: File | undefined): Promise<void> {
    if (!file) return;
    setError('');
    setSummary(null);
    try {
      if (file.size > MAX_IMPORT_BATCH_BYTES * 40) {
        throw new Error('This file is too large to import in one session. Split it and try again.');
      }
      const text = await file.text();
      const batches = splitCsvBatches(text);
      setFileName(file.name);
      setFileText(text);
      setDataRows(batches.dataRows);
      setBatchCount(batches.batches.length);
      setProcessedBatches(0);
      setStartedImportId(null);
      setStep('review');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : messageFor(cause));
      setStep('choose');
    }
  }

  async function run(): Promise<void> {
    setStep('running');
    setError('');
    try {
      const batches = splitCsvBatches(fileText);
      const base = `/organizations/${encodeURIComponent(organizationId)}/contact-imports`;

      // Resume the same import after a failure. Starting a fresh import would
      // discard the API's per-batch idempotency state and reprocess rows that
      // have already been written.
      let importId = startedImportId;
      if (importId === null) {
        const started = await request<{ readonly id: string }>(base, {
          method: 'POST',
          body: { importId: crypto.randomUUID() },
        });
        importId = started.id;
        setStartedImportId(importId);
      }

      for (let index = processedBatches; index < batches.batches.length; index += 1) {
        const csv = batches.batches[index] as string;
        await request<ContactImportBatchResult>(
          `${base}/${encodeURIComponent(importId)}/batches`,
          { method: 'POST', body: { batchNumber: index, csv } },
        );
        setProcessedBatches(index + 1);
      }

      const completed = await request<ContactImportSummary>(
        `${base}/${encodeURIComponent(importId)}/complete`,
        { method: 'POST' },
      );
      setSummary(completed);
      setStep('done');
      onImported();
    } catch (cause) {
      setError(messageFor(cause));
      setStep('review');
    }
  }

  return (
    <section className="card-section contact-import" aria-labelledby="contact-import-heading">
      <header className="card-section__header">
        <div>
          <h2 id="contact-import-heading">Import contacts from CSV</h2>
          <p className="field-hint">
            Up to {MAX_IMPORT_BATCH_ROWS} rows and 256 KiB per batch. Larger files are split
            automatically in this browser.
          </p>
        </div>
      </header>

      <p className="notice notice-info">
        An import never records voice consent. A “consent” or “opted in” column is stored as a
        warning only; record consent evidence separately for each contact before it can be called.
      </p>

      {error && (
        <p className="notice notice-error" role="alert">
          {error}
        </p>
      )}

      {step === 'choose' && (
        <div className="contact-import__chooser">
          <div className="field">
            <label htmlFor="contact-import-file">CSV file</label>
            <input
              ref={input}
              id="contact-import-file"
              type="file"
              accept=".csv,text/csv"
              onChange={(event) => void review(event.target.files?.[0])}
            />
            <span className="field-hint">
              The first row must name the columns. A phone column is required.
            </span>
          </div>
        </div>
      )}

      {step === 'review' && (
        <div className="contact-import__review">
          <dl>
            <div>
              <dt>File</dt>
              <dd>{fileName}</dd>
            </div>
            <div>
              <dt>Contact rows</dt>
              <dd>{dataRows}</dd>
            </div>
            <div>
              <dt>Batches</dt>
              <dd>{batchCount}</dd>
            </div>
          </dl>
          <p className="field-hint">
            Rows that already exist are updated. Rejected rows are reported after the import and do
            not stop the remaining rows.
          </p>
          <div className="button-row">
            <button className="button-primary" type="button" onClick={() => void run()}>
              Start import
            </button>
            <button className="button-secondary" type="button" onClick={clear}>
              Choose another file
            </button>
          </div>
        </div>
      )}

      {step === 'running' && (
        <p role="status">
          Importing batch {Math.min(processedBatches + 1, batchCount)} of {batchCount}…
        </p>
      )}

      {step === 'done' && summary && (
        <div className="contact-import__result" role="status">
          <h3>Import complete</h3>
          <p>{summariseImport(summary)}</p>
          {summary.warnings > 0 && (
            <p>
              Review warnings before using these contacts. Warnings include CSV consent values,
              which are not consent evidence.
            </p>
          )}
          <p className="field-hint">
            Contacts are now in the directory. Consent and suppression still determine who can be
            called.
          </p>
          <button className="button-secondary" type="button" onClick={clear}>
            Import another file
          </button>
        </div>
      )}
    </section>
  );
}
