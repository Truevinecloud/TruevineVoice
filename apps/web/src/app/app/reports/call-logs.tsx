'use client';

import {
  callStateLabel,
  callStateTone,
  formatAnalyticsMoney,
  type AnalyticsCallLog,
} from '../../../lib/analytics';
import { EmptyState, StatusBadge } from '../AppUI';

/**
 * Organization and campaign call logs use the same API rows.
 *
 * The API intentionally does not expose attempt timestamps, raw provider data
 * or contact details, so this table shows only the authorized fields. It says so
 * rather than inventing a time column.
 */
export function CallLogsTable({
  items,
  campaignNames = {},
  emptyTitle = 'No call attempts match these filters',
}: {
  readonly items: readonly AnalyticsCallLog[];
  readonly campaignNames?: Readonly<Record<string, string>>;
  readonly emptyTitle?: string;
}): React.JSX.Element {
  if (items.length === 0) {
    return (
      <EmptyState title={emptyTitle}>
        No call attempt rows were returned for the current selection. This is an empty API result,
        not an estimated or reconciled total.
      </EmptyState>
    );
  }

  return (
    <>
      <div className="table-scroll">
        <table className="table analytics-call-table">
          <caption className="visually-hidden">Call attempts returned by the analytics API</caption>
          <thead>
            <tr>
              <th scope="col">Campaign</th>
              <th scope="col">Attempt</th>
              <th scope="col">Current status</th>
              <th scope="col">Answered</th>
              <th scope="col">Customer charge</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.attemptId}>
                <td>{campaignNames[item.campaignId] ?? item.campaignId}</td>
                <td className="analytics-reference">{item.attemptId}</td>
                <td>
                  <StatusBadge tone={callStateTone(item.state)}>{callStateLabel(item.state)}</StatusBadge>
                </td>
                <td>{item.answered ? 'Yes' : 'No'}</td>
                <td className="analytics-money">{formatAnalyticsMoney(item.spend)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="field-hint">
        Attempt timestamps, provider payloads and contact details are not exposed by this API. The
        charge column is the exact customer charge in integer UGX minor units, not provider cost.
      </p>
    </>
  );
}
