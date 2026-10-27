// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ContactImportPanel } from './contact-import-panel';

interface Recorded {
  readonly url: string;
  readonly method: string;
  readonly body: unknown;
}

let root: Root;
let host: HTMLDivElement;
let requests: Recorded[];
let batchShouldFail: (attempt: number, batchNumber: number) => boolean;
interface BatchRow {
  readonly rowNumber: number;
  readonly outcome: 'CREATED' | 'UPDATED' | 'UNCHANGED' | 'REJECTED';
  readonly code?: string;
  readonly warningCodes: readonly string[];
}
let batchRowsFor: (batchNumber: number) => readonly BatchRow[];
const onImported = vi.fn();

const summary = {
  importId: 'imp-1',
  status: 'COMPLETED',
  nextBatchNumber: 2,
  rowsProcessed: 251,
  created: 200,
  updated: 40,
  unchanged: 8,
  rejected: 3,
  warnings: 1,
  createdAt: '2026-10-27T00:00:00.000Z',
  completedAt: '2026-10-27T00:01:00.000Z',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function button(label: string): HTMLButtonElement {
  const element = [...host.querySelectorAll('button')].find(
    (entry) => entry.textContent?.trim() === label,
  );
  if (!element) throw new Error(`Missing button: ${label}`);
  return element;
}

async function click(label: string): Promise<void> {
  await act(async () => {
    button(label).click();
  });
}

/** 251 data rows become two batches at the API limit of 250. */
function csvWith(rows: number): string {
  return [
    'phone,name',
    ...Array.from({ length: rows }, (_, i) => `+256772${String(i).padStart(6, '0')},Person ${i}`),
  ].join('\n');
}

async function chooseFile(text: string, name = 'contacts.csv'): Promise<void> {
  const file = new File([text], name, { type: 'text/csv' });
  const input = host.querySelector<HTMLInputElement>('#contact-import-file')!;
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  await act(async () => {
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  // File.text() resolves asynchronously.
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  document.cookie = 'tv_csrf=synthetic-csrf; path=/';
  requests = [];
  batchShouldFail = () => false;
  batchRowsFor = () => [];
  onImported.mockReset();
  const batchAttempts = new Map<number, number>();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
      requests.push({ url, method, body });

      if (method === 'POST' && /\/contact-imports$/.test(url)) {
        return json({ id: 'imp-1' }, 201);
      }
      if (method === 'POST' && url.endsWith('/batches')) {
        const batchNumber = (body as { batchNumber: number }).batchNumber;
        const attempt = (batchAttempts.get(batchNumber) ?? 0) + 1;
        batchAttempts.set(batchNumber, attempt);
        if (batchShouldFail(attempt, batchNumber)) {
          return json({ error: { code: 'unexpected_error', message: 'Batch write failed.' } }, 500);
        }
        return json({ rows: batchRowsFor(batchNumber), summary });
      }
      if (method === 'POST' && url.endsWith('/complete')) return json(summary);
      return json({});
    }),
  );
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  host.remove();
  vi.unstubAllGlobals();
});

describe('ContactImportPanel', () => {
  it('states that imported consent is not consent evidence', async () => {
    await act(async () => {
      root.render(<ContactImportPanel organizationId="org-a" onImported={onImported} />);
    });

    expect(host.textContent).toContain('An import never records voice consent');
    expect(host.textContent).toContain('record consent evidence separately');
    expect(host.textContent).toContain('250 rows');
  });

  it('drives start, every batch and completion in order', async () => {
    await act(async () => {
      root.render(<ContactImportPanel organizationId="org-a" onImported={onImported} />);
    });
    await chooseFile(csvWith(251));

    expect(host.textContent).toContain('Contact rows');
    expect(host.textContent).toContain('251');
    expect(host.textContent).toContain('2');

    await click('Start import');

    expect(requests.map((request) => `${request.method} ${request.url}`)).toEqual([
      'POST /api/organizations/org-a/contact-imports',
      'POST /api/organizations/org-a/contact-imports/imp-1/batches',
      'POST /api/organizations/org-a/contact-imports/imp-1/batches',
      'POST /api/organizations/org-a/contact-imports/imp-1/complete',
    ]);
    expect((requests[1]!.body as { batchNumber: number }).batchNumber).toBe(0);
    expect((requests[2]!.body as { batchNumber: number }).batchNumber).toBe(1);
    // Every batch repeats the header row.
    expect((requests[1]!.body as { csv: string }).csv.split('\n')[0]).toBe('phone,name');
    expect((requests[2]!.body as { csv: string }).csv.split('\n')[0]).toBe('phone,name');

    expect(host.textContent).toContain('Import complete');
    expect(host.textContent).toContain('251 rows processed');
    expect(host.textContent).toContain('Warnings include CSV consent values');
    expect(onImported).toHaveBeenCalledTimes(1);
  });

  it('resumes the same import after a failed batch instead of starting a new one', async () => {
    batchShouldFail = (attempt, batchNumber) => batchNumber === 1 && attempt === 1;
    await act(async () => {
      root.render(<ContactImportPanel organizationId="org-a" onImported={onImported} />);
    });
    await chooseFile(csvWith(251));

    await click('Start import');
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('Batch write failed.');
    expect(host.textContent).toContain('Start import');

    await click('Start import');

    const starts = requests.filter(
      (request) => request.method === 'POST' && /\/contact-imports$/.test(request.url),
    );
    expect(starts).toHaveLength(1);
    const batchNumbers = requests
      .filter((request) => request.url.endsWith('/batches'))
      .map((request) => (request.body as { batchNumber: number }).batchNumber);
    // Batch 0 was not resent; only the failed batch 1 ran again.
    expect(batchNumbers).toEqual([0, 1, 1]);
    expect(host.textContent).toContain('Import complete');
    expect(onImported).toHaveBeenCalledTimes(1);
  });

  it('lists rejected rows by their position in the uploaded file', async () => {
    batchRowsFor = (batchNumber) =>
      batchNumber === 0
        ? [
            { rowNumber: 3, outcome: 'REJECTED', code: 'invalid_phone', warningCodes: [] },
            {
              rowNumber: 250,
              outcome: 'REJECTED',
              code: 'duplicate_phone_in_batch',
              warningCodes: [],
            },
            { rowNumber: 4, outcome: 'CREATED', warningCodes: [] },
          ]
        : [
            // The API numbers rows inside the batch it received; this is the
            // 251st data row of the file, so it must be reported as row 252.
            { rowNumber: 2, outcome: 'REJECTED', code: 'invalid_email', warningCodes: [] },
          ];

    await act(async () => {
      root.render(<ContactImportPanel organizationId="org-a" onImported={onImported} />);
    });
    await chooseFile(csvWith(251));
    await click('Start import');

    expect(host.textContent).toContain('Rejected rows were not imported');
    expect(host.textContent).toContain('row 3 (phone number not recognised)');
    expect(host.textContent).toContain('row 250 (duplicate phone number in the file)');
    expect(host.textContent).toContain('row 252 (email address not recognised)');
    // Nothing about the contacts themselves is repeated in the report.
    expect(host.textContent).not.toContain('Person 250');
  });

  it('preserves original multiline file positions and rejection reports when resuming a batch', async () => {
    batchShouldFail = (attempt, batchNumber) => batchNumber === 1 && attempt === 1;
    batchRowsFor = () => [
      { rowNumber: 2, outcome: 'REJECTED', code: 'invalid_phone', warningCodes: [] },
    ];
    await act(async () => {
      root.render(<ContactImportPanel organizationId="org-a" onImported={onImported} />);
    });
    const csv = csvWith(251).replace('Person 0', '"Person\nzero"');
    await chooseFile(csv);
    await click('Start import');
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('Batch write failed.');
    await click('Start import');

    expect(host.textContent).toContain('row 2 (phone number not recognised)');
    expect(host.textContent).toContain('row 253 (phone number not recognised)');
    expect(host.textContent?.match(/row 2 \(phone number not recognised\)/g)).toHaveLength(1);
    expect(
      requests
        .filter((request) => request.url.endsWith('/batches'))
        .map((request) => (request.body as { batchNumber: number }).batchNumber),
    ).toEqual([0, 1, 1]);
    expect(onImported).toHaveBeenCalledTimes(1);
  });

  it('rejects a file that has no contact rows before any request', async () => {
    await act(async () => {
      root.render(<ContactImportPanel organizationId="org-a" onImported={onImported} />);
    });
    await chooseFile('phone\n');

    expect(host.querySelector('[role="alert"]')?.textContent).toContain(
      'The file has a header but no contact rows.',
    );
    expect(requests).toHaveLength(0);
  });
});
