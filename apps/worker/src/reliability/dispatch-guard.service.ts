import { randomUUID } from 'node:crypto';

import { lockCampaignDispatch, lockWalletBalance } from '@truevine/database';
import type { CallSql } from '@truevine/telephony';

import type { DispatchCostInput, DispatchCostPolicy } from './dispatch-cost-policy.js';

export type DispatchBlockReason =
  | 'campaign_not_active'
  | 'campaign_paused'
  | 'campaign_cancelled'
  | 'campaign_emergency_stopped'
  | 'organization_suspended'
  | 'insufficient_balance'
  | 'dispatch_policy_unavailable';

export type DispatchAuthorization =
  | { readonly ok: true; readonly reservationId: string; readonly amountMinor: bigint; readonly policyVersion: string }
  | { readonly ok: false; readonly reason: DispatchBlockReason };

export interface DispatchGuardInput extends DispatchCostInput {
  readonly campaignId: string;
}

interface CampaignStateRow {
  readonly status: string;
  readonly dispatch_state: string;
  readonly emergency_stopped: boolean;
  readonly organization_suspended: boolean;
}

interface SumRow {
  readonly total: string | null;
}

const MAX_BIGINT = 9223372036854775807n;

/**
 * Authorizes one paid provider invocation.
 *
 * The caller must hold an open transaction. Campaign and wallet advisory locks
 * are taken in that transaction and stay held until the caller commits after
 * the provider call, so a concurrent stop cannot commit while a call is
 * starting. Every guard reads the authoritative PostgreSQL state; Redis, job
 * payloads and prior worker state are never trusted here.
 */
export class DispatchGuard {
  constructor(private readonly policy: DispatchCostPolicy) {}

  async authorize(tx: CallSql, input: DispatchGuardInput): Promise<DispatchAuthorization> {
    await lockCampaignDispatch(tx, input.organizationId, input.campaignId);
    await lockWalletBalance(tx, input.organizationId, input.currency);

    const [state] = await tx.$queryRaw<CampaignStateRow[]>`
      SELECT c.status::text AS status,
             c.dispatch_state AS dispatch_state,
             (c.emergency_stopped_at IS NOT NULL) AS emergency_stopped,
             (o.suspended_at IS NOT NULL) AS organization_suspended
      FROM campaigns c
      JOIN organizations o ON o.id = c.organization_id
      WHERE c.organization_id = ${input.organizationId}::uuid
        AND c.id = ${input.campaignId}::uuid`;
    if (!state) return { ok: false, reason: 'campaign_not_active' };
    if (state.emergency_stopped) return { ok: false, reason: 'campaign_emergency_stopped' };
    if (state.dispatch_state === 'CANCELLED') return { ok: false, reason: 'campaign_cancelled' };
    if (state.dispatch_state === 'PAUSED') return { ok: false, reason: 'campaign_paused' };
    if (state.status !== 'ACTIVE') return { ok: false, reason: 'campaign_not_active' };
    if (state.organization_suspended) return { ok: false, reason: 'organization_suspended' };

    const [balance] = await tx.$queryRaw<SumRow[]>`
      SELECT COALESCE(SUM(amount_minor), 0)::text AS total
      FROM wallet_entries
      WHERE organization_id = ${input.organizationId}::uuid AND currency = 'UGX'`;
    const [held] = await tx.$queryRaw<SumRow[]>`
      SELECT COALESCE(SUM(amount_minor), 0)::text AS total
      FROM campaign_dispatch_reservations
      WHERE organization_id = ${input.organizationId}::uuid
        AND currency = 'UGX' AND state = 'HELD'`;

    const reserve = await this.policy.reserve(input);
    if (!reserve || reserve.currency !== 'UGX' || reserve.amountMinor < 0n || reserve.amountMinor > MAX_BIGINT) {
      await this.pauseForSystemReason(tx, input, 'dispatch_policy_unavailable');
      return { ok: false, reason: 'dispatch_policy_unavailable' };
    }

    const available = BigInt(balance?.total ?? '0') - BigInt(held?.total ?? '0');
    if (available < reserve.amountMinor) {
      await this.pauseForSystemReason(tx, input, 'insufficient_balance');
      return { ok: false, reason: 'insufficient_balance' };
    }

    const reservationId = randomUUID();
    const inserted = await tx.$executeRaw`
      INSERT INTO campaign_dispatch_reservations (
        organization_id, id, attempt_id, amount_minor, currency, state, policy_version
      )
      VALUES (
        ${input.organizationId}::uuid, ${reservationId}::uuid, ${input.attemptId}::uuid,
        ${reserve.amountMinor.toString()}::bigint, 'UGX', 'HELD', ${reserve.policyVersion}
      )`;
    if (inserted !== 1) throw new Error('dispatch_reservation_conflict');

    return {
      ok: true,
      reservationId,
      amountMinor: reserve.amountMinor,
      policyVersion: reserve.policyVersion,
    };
  }

  private async pauseForSystemReason(
    tx: CallSql,
    input: DispatchGuardInput,
    reason: 'insufficient_balance' | 'dispatch_policy_unavailable',
  ): Promise<void> {
    const now = new Date();
    await tx.$executeRaw`
      UPDATE campaigns
      SET dispatch_state = 'PAUSED',
          paused_at = ${now},
          dispatch_stop_reason = ${reason},
          dispatch_epoch = dispatch_epoch + 1,
          updated_at = ${now}
      WHERE organization_id = ${input.organizationId}::uuid
        AND id = ${input.campaignId}::uuid
        AND status = 'ACTIVE'
        AND dispatch_state = 'RUNNING'
        AND emergency_stopped_at IS NULL`;
  }
}
