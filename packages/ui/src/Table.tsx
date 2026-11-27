/**
 * Table — accessible data table component.
 *
 * Renders a <table> with <thead> and <tbody>. Columns are defined by the
 * `columns` array of { key, label } pairs. Rows are rendered via the `row`
 * render prop receiving the row object and its index.
 */

import type { ReactElement } from 'react';

export interface TableColumn {
  readonly key: string;
  readonly label: string;
}

export interface TableProps<T extends Record<string, unknown>> {
  readonly columns: readonly TableColumn[];
  readonly rows: readonly T[];
  readonly row: (item: T, index: number) => React.ReactNode;
  readonly caption?: string;
  readonly className?: string;
}

export function Table<T extends Record<string, unknown>>({
  columns,
  rows,
  row,
  caption,
  className = '',
}: TableProps<T>): ReactElement {
  return (
    <div className={`table-container ${className}`.trim()}>
      <table className="table">
        {caption && <caption className="table-caption">{caption}</caption>}
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column.key} scope="col">
                {column.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((item, index) => (
            <tr key={String(index)}>{row(item, index)}</tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
