import type { CallSql } from '@truevine/telephony';

/**
 * Reservations are non-financial coordination rows. They are transitioned
 * inside the caller's existing transaction; wallet debits remain the only
 * financial state change and are never edited here.
 */
export async function settleDispatchReservation(
  tx: CallSql,
  organizationId: string,
  attemptId: string,
): Promise<void> {
  await tx.$executeRaw`
    UPDATE campaign_dispatch_reservations
    SET state = 'SETTLED', updated_at = now()
    WHERE organization_id = ${organizationId}::uuid
      AND attempt_id = ${attemptId}::uuid
      AND state = 'HELD'`;
}

export async function releaseDispatchReservation(
  tx: CallSql,
  organizationId: string,
  attemptId: string,
): Promise<void> {
  await tx.$executeRaw`
    UPDATE campaign_dispatch_reservations
    SET state = 'RELEASED', updated_at = now()
    WHERE organization_id = ${organizationId}::uuid
      AND attempt_id = ${attemptId}::uuid
      AND state = 'HELD'`;
}
