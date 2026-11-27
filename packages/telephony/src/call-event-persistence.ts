import { randomUUID } from 'node:crypto';

import { isTerminal, type CallState } from '@truevine/domain';

import { CallPersistenceError, eventDisposition, fingerprint, key, usageEvidence, uuid, type UsageEvidence } from './call-contract.js';

export interface CallSql {
  $queryRaw<T = unknown>(sql: TemplateStringsArray, ...values: unknown[]): Promise<T>;
  $executeRaw(sql: TemplateStringsArray, ...values: unknown[]): Promise<number>;
}
export interface CallDatabase extends CallSql {
  $transaction<T>(body: (tx: CallSql) => Promise<T>): Promise<T>;
}

export interface RecordCallEvent {
  organizationId: string;
  attemptId: string;
  eventKey: string;
  state: CallState;
  occurredAt: Date;
  providerUsage?: UsageEvidence;
}

/** Caller owns the transaction so receipt completion and call mutation can commit together. */
export async function recordCallEvent(tx: CallSql, input: RecordCallEvent) {
  const org = uuid(input.organizationId),
    attempt = uuid(input.attemptId),
    eventKey = key(input.eventKey);
  eventDisposition('QUEUED', input.state);
  if (!(input.occurredAt instanceof Date) || !Number.isFinite(input.occurredAt.getTime()))
    throw new CallPersistenceError('invalid_request');
  const usage = usageEvidence(input.providerUsage);
  const hash = fingerprint([1, input.state, input.occurredAt.toISOString(), usage]);

  const attempts = await tx.$queryRaw<{ state: CallState }[]>`
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
}
