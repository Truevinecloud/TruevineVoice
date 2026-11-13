'use client';
import { TechnicalResource } from '../technical-resource';
import { QueuesPanel, type QueueView } from '../technical-ui';
export default function TechnicalQueuesPage() {
  return (
    <TechnicalResource<QueueView>
      title="Jobs and queues"
      section="queues"
      endpoint="/platform/technical/queues"
    >
      {(queues) => (
        <>
          <QueuesPanel queues={queues} />
          <p className="footnote">
            Job search, failure details, retries and recovery are unavailable until a business queue
            and durable job history are integrated.
          </p>
        </>
      )}
    </TechnicalResource>
  );
}
