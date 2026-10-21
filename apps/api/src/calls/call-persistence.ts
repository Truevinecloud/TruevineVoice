import { randomUUID } from 'node:crypto';
import { isTerminal, type CallState } from '@truevine/domain';
import {
  CallPersistenceError,
  canonicalRequest,
  destination,
  eventDisposition,
  fingerprint,
  key,
  usageEvidence,
  uuid,
  type AcceptCall,
  type UsageEvidence,
} from './call-contract.js';

export interface CallSql {
  $queryRaw<T = unknown>(sql: TemplateStringsArray, ...values: unknown[]): Promise<T>;
  $executeRaw(sql: TemplateStringsArray, ...values: unknown[]): Promise<number>;
}
export interface CallDatabase extends CallSql {
  $transaction<T>(body: (tx: CallSql) => Promise<T>): Promise<T>;
}
export interface AcceptedCall {
  organizationId: string;
  attemptId: string;
  executionId: string;
  recipientId: string;
  destination: string;
  attemptNumber: number;
  state: 'QUEUED';
}
interface Attempt {
  id: string;
  state: CallState;
  attempt_number: number;
}

/**
 * Internal application boundary only: intentionally not registered in AppModule.
 * Callers supply an authorized organization; no HTTP, provider or queue capability.
 * Narrow structural SQL seam; the caller owns the connection lifecycle.
 */
export class CallPersistence {
  constructor(private readonly database: CallDatabase) {}

  async createContact(organizationId: string, to: string, label = '') {
    const org = uuid(organizationId),
      phone = destination(to);
    if (typeof label !== 'string' || label.trim().length > 200)
      throw new CallPersistenceError('invalid_request');
    const id = randomUUID();
    await this.database.$executeRaw`
      INSERT INTO contacts(organization_id,id,destination,label,updated_at)
      VALUES (${org}::uuid,${id}::uuid,${phone},${label.trim()},now())`;
    return { organizationId: org, id, destination: phone, label: label.trim() };
  }

  async updateContact(organizationId: string, contactId: string, to: string) {
    const org = uuid(organizationId),
      id = uuid(contactId),
      phone = destination(to);
    const count = await this.database.$executeRaw`
      UPDATE contacts SET destination=${phone},updated_at=now()
      WHERE organization_id=${org}::uuid AND id=${id}::uuid`;
    if (!count) throw new CallPersistenceError('not_found');
  }

  async addRecipient(organizationId: string, campaignId: string, contactId: string) {
    const org = uuid(organizationId),
      campaign = uuid(campaignId),
      contact = uuid(contactId);
    return this.database.$transaction(async (tx) => {
      const parents = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM campaigns WHERE organization_id=${org}::uuid AND id=${campaign}::uuid FOR UPDATE`;
      if (!parents.length) throw new CallPersistenceError('not_found');
      const existing = await tx.$queryRaw<{ id: string; destination: string }[]>`
        SELECT id,destination FROM campaign_recipients
        WHERE organization_id=${org}::uuid AND campaign_id=${campaign}::uuid AND contact_id=${contact}::uuid`;
      if (existing[0]) return existing[0];
      const rows = await tx.$queryRaw<{ id: string; destination: string }[]>`
        INSERT INTO campaign_recipients(organization_id,id,campaign_id,contact_id,destination)
        SELECT ${org}::uuid,${randomUUID()}::uuid,${campaign}::uuid,id,destination
        FROM contacts WHERE organization_id=${org}::uuid AND id=${contact}::uuid
        RETURNING id,destination`;
      if (!rows[0]) throw new CallPersistenceError('not_found');
      return rows[0];
    });
  }

  async accept(input: AcceptCall): Promise<AcceptedCall> {
    const request = canonicalRequest(input);
    const { organizationId: org, campaignId: campaign, recipientId: recipient } = request;
    return this.database.$transaction(async (tx) => {
      // Collisions only serialize unrelated requests; full DB uniqueness remains authoritative.
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify([org, 'call.accept', request.idempotencyKey])},0))::text`;
      const replay = await tx.$queryRaw<
        { fingerprint: string; fingerprint_version: number; result: AcceptedCall }[]
      >`
        SELECT fingerprint,fingerprint_version,result FROM call_operations
        WHERE organization_id=${org}::uuid AND operation='call.accept' AND key=${request.idempotencyKey}`;
      if (replay[0]) {
        if (replay[0].fingerprint_version !== 1 || replay[0].fingerprint !== request.fingerprint)
          throw new CallPersistenceError('idempotency_conflict');
        return replay[0].result;
      }
      const campaigns = await tx.$queryRaw<
        { id: string; suspended_at: Date | null; emergency_stopped_at: Date | null }[]
      >`
        SELECT c.id,o.suspended_at,c.emergency_stopped_at FROM campaigns c
        JOIN organizations o ON o.id=c.organization_id
        WHERE c.organization_id=${org}::uuid AND c.id=${campaign}::uuid FOR UPDATE OF c,o`;
      if (!campaigns[0]) throw new CallPersistenceError('not_found');
      if (campaigns[0].suspended_at || campaigns[0].emergency_stopped_at)
        throw new CallPersistenceError('invalid_request');
      const recipients = await tx.$queryRaw<{ destination: string }[]>`
        SELECT destination FROM campaign_recipients
        WHERE organization_id=${org}::uuid AND campaign_id=${campaign}::uuid AND id=${recipient}::uuid`;
      if (!recipients[0]) throw new CallPersistenceError('not_found');
      await tx.$executeRaw`
        INSERT INTO campaign_executions(organization_id,id,campaign_id)
        VALUES (${org}::uuid,${randomUUID()}::uuid,${campaign}::uuid)
        ON CONFLICT(organization_id,campaign_id) DO NOTHING`;
      const executions = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM campaign_executions
        WHERE organization_id=${org}::uuid AND campaign_id=${campaign}::uuid FOR UPDATE`;
      const execution = executions[0];
      if (!execution) throw new CallPersistenceError('not_found');
      const attempts = await tx.$queryRaw<Attempt[]>`
        SELECT id,state,attempt_number FROM call_attempts
        WHERE organization_id=${org}::uuid AND execution_id=${execution.id}::uuid AND recipient_id=${recipient}::uuid
        ORDER BY attempt_number DESC LIMIT 1 FOR UPDATE`;
      const previous = attempts[0];
      if (!request.previousAttemptId && previous)
        throw new CallPersistenceError('duplicate_execution');
      if (
        request.previousAttemptId &&
        (!previous || previous.id !== request.previousAttemptId || !isTerminal(previous.state))
      )
        throw new CallPersistenceError('invalid_redial');
      const result: AcceptedCall = {
        organizationId: org,
        attemptId: randomUUID(),
        executionId: execution.id,
        recipientId: recipient,
        destination: recipients[0].destination,
        attemptNumber: previous ? previous.attempt_number + 1 : 1,
        state: 'QUEUED',
      };
      await tx.$executeRaw`
        INSERT INTO call_attempts(organization_id,id,campaign_id,execution_id,recipient_id,destination,
          attempt_number,previous_attempt_id,redial_reason)
        VALUES (${org}::uuid,${result.attemptId}::uuid,${campaign}::uuid,${execution.id}::uuid,
          ${recipient}::uuid,${result.destination},${result.attemptNumber},
          ${request.previousAttemptId}::uuid,${request.redialReason})`;
      await tx.$executeRaw`
        INSERT INTO call_operations(organization_id,operation,key,fingerprint_version,fingerprint,attempt_id,result)
        VALUES (${org}::uuid,'call.accept',${request.idempotencyKey},1,${request.fingerprint},
          ${result.attemptId}::uuid,${JSON.stringify(result)}::jsonb)`;
      return result;
    });
  }

  async recordEvent(input: {
    organizationId: string;
    attemptId: string;
    eventKey: string;
    state: CallState;
    occurredAt: Date;
    providerUsage?: UsageEvidence;
  }) {
    const org = uuid(input.organizationId),
      attempt = uuid(input.attemptId),
      eventKey = key(input.eventKey);
    eventDisposition('QUEUED', input.state);
    if (!(input.occurredAt instanceof Date) || !Number.isFinite(input.occurredAt.getTime()))
      throw new CallPersistenceError('invalid_request');
    const usage = usageEvidence(input.providerUsage);
    const hash = fingerprint([1, input.state, input.occurredAt.toISOString(), usage]);
    return this.database.$transaction(async (tx) => {
      const attempts = await tx.$queryRaw<Attempt[]>`
        SELECT id,state,attempt_number FROM call_attempts
        WHERE organization_id=${org}::uuid AND id=${attempt}::uuid FOR UPDATE`;
      const current = attempts[0];
      if (!current) throw new CallPersistenceError('not_found');
      const receipts = await tx.$queryRaw<{ fingerprint: string }[]>`
        SELECT fingerprint FROM call_events
        WHERE organization_id=${org}::uuid AND attempt_id=${attempt}::uuid AND event_key=${eventKey} AND disposition<>'CONFLICT'`;
      let disposition = eventDisposition(current.state, input.state);
      if (receipts.length)
        disposition = receipts.every((receipt) => receipt.fingerprint === hash)
          ? 'DUPLICATE'
          : 'CONFLICT';
      if (
        isTerminal(current.state) &&
        usage !== null &&
        disposition === 'DUPLICATE' &&
        receipts.length === 0
      ) {
        const evidence = await tx.$queryRaw<{ provider_usage: UsageEvidence }[]>`
          SELECT provider_usage FROM call_events
          WHERE organization_id=${org}::uuid AND attempt_id=${attempt}::uuid
            AND requested_state=${current.state}::"CallAttemptState"
            AND disposition<>'CONFLICT' AND provider_usage IS NOT NULL`;
        if (
          evidence.some(
            (event) => fingerprint([usageEvidence(event.provider_usage)]) !== fingerprint([usage]),
          )
        )
          disposition = 'CONFLICT';
      }

      if (disposition === 'APPLIED')
        await tx.$executeRaw`UPDATE call_attempts SET state=${input.state}::"CallAttemptState"
          WHERE organization_id=${org}::uuid AND id=${attempt}::uuid`;
      await tx.$executeRaw`
        INSERT INTO call_events(organization_id,id,attempt_id,event_key,fingerprint,requested_state,
          disposition,provider_usage,occurred_at)
        VALUES (${org}::uuid,${randomUUID()}::uuid,${attempt}::uuid,${eventKey},${hash},
          ${input.state}::"CallAttemptState",${disposition},${usage === null ? null : JSON.stringify(usage)}::jsonb,
          ${input.occurredAt})`;
      return {
        disposition,
        state: disposition === 'APPLIED' ? input.state : current.state,
        ...(disposition === 'CONFLICT' || disposition === 'ILLEGAL'
          ? { diagnostic: { code: 'call_event_conflict', organizationId: org, attemptId: attempt } }
          : {}),
      };
    });
  }
}
