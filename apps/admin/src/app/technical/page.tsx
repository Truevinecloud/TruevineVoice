'use client';
import Link from 'next/link';
import { TechnicalResource } from './technical-resource';
import { OverviewPanels, type OverviewView } from './technical-ui';
export default function TechnicalOverviewPage() {
  return (
    <TechnicalResource<OverviewView>
      title="Technical overview"
      section="overview"
      endpoint="/platform/technical/overview"
    >
      {(overview) => (
        <>
          <section className="card">
            <div className="section-heading">
              <h2>System diagnostics</h2>
              <time>{overview.application.timestamp}</time>
            </div>
            <OverviewPanels overview={overview} />
          </section>
          <section className="card">
            <h2>Technical activity and incidents</h2>
            <p>
              Review recorded platform operations in the{' '}
              <Link href="/technical/audit">audit trail</Link>. A dedicated incident store and
              searchable application logs are unavailable.
            </p>
          </section>
        </>
      )}
    </TechnicalResource>
  );
}
