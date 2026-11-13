'use client';
import { TechnicalResource } from '../technical-resource';
import { ProvidersTable, type ProviderRow } from '../technical-ui';
export default function TechnicalProvidersPage() {
  return (
    <TechnicalResource<{ providers: ProviderRow[]; notAvailable: string[] }>
      title="Providers"
      section="providers"
      endpoint="/platform/technical/providers"
    >
      {(data) => (
        <section className="card">
          <div className="section-heading">
            <h2>Provider connectivity</h2>
            <span>{data.providers.length} declared</span>
          </div>
          <ProvidersTable providers={data.providers} />
          <p className="footnote">
            No live connection test or credential changes are supported. Unavailable:{' '}
            {data.notAvailable.join(', ')}.
          </p>
        </section>
      )}
    </TechnicalResource>
  );
}
