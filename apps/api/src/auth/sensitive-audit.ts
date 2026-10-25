import { createHash } from 'node:crypto';
import { sensitiveAudit, assertKnownAuditAction, isSafeAuditMetadata } from '@truevine/auth';
import { auditRequestId } from './audit-context.js';
/** Text fields are represented by digests, not copied into indefinite audit history. */
export function auditDigest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
export function mutationAudit(input: Parameters<typeof sensitiveAudit>[0]) {
  return sensitiveAudit({ ...input, requestId: input.requestId ?? auditRequestId() });
}
export function campaignAuditState(row: {
  name: string;
  status: string;
  emergencyStoppedAt?: Date | null;
  scheduledAt?: Date | null;
  retryMaxAttempts?: number;
  retryDelayMinutes?: number;
  audienceGroupIds?: readonly string[];
  audioAssetId?: string | null;
}) {
  return {
    nameDigest: auditDigest(row.name),
    status: row.status,
    emergencyStoppedAt: row.emergencyStoppedAt?.toISOString() ?? null,
    audioSelected: Boolean(row.audioAssetId),
    scheduledAt: row.scheduledAt?.toISOString() ?? null,
    retryMaxAttempts: row.retryMaxAttempts ?? 1,
    retryDelayMinutes: row.retryDelayMinutes ?? 60,
    audienceGroupCount: row.audienceGroupIds?.length ?? 0,
    audienceGroupsDigest: auditDigest([...(row.audienceGroupIds ?? [])].sort()),
  };
}
export function billingAuditState(row: unknown) {
  return row === null ? null : { configured: true, detailsDigest: auditDigest(row) };
}

/** Shared insert into the existing tenant trail, using the caller's transaction. */
export async function writeMutationAudit(
  tx: Pick<import('@truevine/database').PrismaClient, 'securityAuditEvent'>,
  input: {
    organizationId: string;
    actorUserId: string;
    action: string;
    targetType: string;
    targetId: string;
    before: Readonly<Record<string, unknown>> | null;
    change: Readonly<Record<string, unknown>>;
    after: Readonly<Record<string, unknown>> | null;
    reasonCode: string;
    scope?: 'ORGANIZATION' | 'PLATFORM';
    outcome?: 'SUCCESS' | 'DENIED';
    legacy?: Readonly<Record<string, unknown>>;
  },
): Promise<void> {
  assertKnownAuditAction(input.action);
  const metadata = { ...input.legacy, ...mutationAudit(input) };
  if (!isSafeAuditMetadata(metadata)) throw new Error('Unsafe audit metadata.');
  await tx.securityAuditEvent.create({
    data: {
      organizationId: input.organizationId,
      actorUserId: input.actorUserId,
      action: input.action,
      scope: input.scope ?? 'ORGANIZATION',
      outcome: input.outcome ?? 'SUCCESS',
      targetType: input.targetType,
      targetId: input.targetId,
      metadata: metadata as never,
    },
  });
}

/** Refusals are recorded after rollback; audit outages cannot mask the refusal. */
export async function mutationRefused(
  client: Pick<import('@truevine/database').PrismaClient, 'securityAuditEvent'>,
  event: {
    organizationId: string;
    actorUserId: string;
    action: string;
    targetType: string;
    targetId: string;
    scope?: 'ORGANIZATION' | 'PLATFORM';
  },
  error: unknown,
): Promise<never> {
  const { AuthError } = await import('@truevine/auth');
  try {
    await writeMutationAudit(client, {
      ...event,
      action: 'authorization.denied',
      outcome: 'DENIED',
      before: null,
      change: { attemptedAction: event.action, failed: true },
      after: null,
      reasonCode: error instanceof AuthError ? error.code : 'mutation_failed',
    });
  } catch {
    process.stderr.write('[audit] Refusal recording unavailable.\n');
  }
  throw error;
}
