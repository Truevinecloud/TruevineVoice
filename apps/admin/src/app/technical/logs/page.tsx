'use client';
import { TechnicalResource } from '../technical-resource';
import { LogsPanel, type LogView } from '../technical-ui';
export default function TechnicalLogsPage() {
  return (
    <TechnicalResource<LogView>
      title="Logs availability"
      section="logs"
      endpoint="/platform/technical/logs"
    >
      {(logs) => (
        <>
          <LogsPanel logs={logs} />
          <p className="footnote">
            Search, severity/date filters, request IDs and correlation IDs require a queryable log
            store. No application log contents are exposed here.
          </p>
        </>
      )}
    </TechnicalResource>
  );
}
