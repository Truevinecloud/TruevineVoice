import {
  bindCallbackSession,
  canonicalCampaignCallInitiation,
  FakeVoiceAdapter,
  type CallSql,
  type VoicePort,
} from '@truevine/telephony';

import { DispatchGuard, type DispatchBlockReason } from '../reliability/dispatch-guard.service.js';
import { releaseDispatchReservation } from '../reliability/dispatch-reservation.js';

import { CampaignExecutionClaimService, type ClaimResult } from './campaign-execution-claim.service.js';
import {
  CallInitiationReconciliationService,
  type ReconciliationClient,
} from './call-initiation-reconciliation.service.js';

export type InitiationResult =
  | { readonly status: 'initiated'; readonly attemptId: string; readonly providerCallId: string; readonly replayed: boolean }
  | { readonly status: 'failed_before_provider'; readonly attemptId: string; readonly reconciliationRequired: false }
  | {
      readonly status: 'blocked';
      readonly reason: DispatchBlockReason;
      readonly attemptId: string;
      readonly reconciliationRequired: false;
    }
  | {
      readonly status: 'uncertain';
      readonly attemptId: string;
      readonly outcome: 'unknown_provider_outcome';
      readonly reconciliationRequired: true;
    }
  | { readonly status: ClaimResult['status'] };

export interface InitiationInput {
  readonly organizationId: string;
  readonly campaignId: string;
  readonly recipientId: string;
}

type Tx = CallSql & {
  callAttempt: {
    findUnique(input: unknown): Promise<{ destination: string; attemptNumber: number } | null>;
    updateMany(input: unknown): Promise<{ count: number }>;
  };
  callOperation: {
    findUnique(input: unknown): Promise<Record<string, unknown> | null>;
    create(input: unknown): Promise<Record<string, unknown>>;
  };
  callInitiationReconciliation: ReconciliationClient['callInitiationReconciliation'];
};

export class CampaignCallInitiationService {
  constructor(
    private readonly claimService: CampaignExecutionClaimService,
    private readonly voice: VoicePort,
    private readonly prisma: Pick<Tx, 'callAttempt' | 'callOperation'> & {
      $transaction<T>(work: (tx: Tx) => Promise<T>): Promise<T>;
    },
    // Supplied by trusted adapter composition, including the provider account scope.
    private readonly bindingSource: string,
    private readonly reconciliation: CallInitiationReconciliationService,
    private readonly dispatchGuard: DispatchGuard,
  ) {}

  async initiate(input: InitiationInput): Promise<InitiationResult> {
    const claim = await this.claimService.claim({
      organizationId: input.organizationId,
      campaignId: input.campaignId,
      recipientId: input.recipientId,
    });

    if (claim.status !== 'claimed' && claim.status !== 'already_claimed') {
      return { status: claim.status };
    }

    const { attemptId } = claim;
    const attempt = await this.prisma.callAttempt.findUnique({
      where: {
        organizationId_id: {
          organizationId: input.organizationId,
          id: attemptId,
        },
      },
      select: { destination: true, attemptNumber: true },
    });
    if (!attempt) throw new Error('dispatch_attempt_missing_after_claim');
    const request = canonicalCampaignCallInitiation({
      organizationId: input.organizationId,
      campaignId: input.campaignId,
      recipientId: input.recipientId,
      attemptId,
      attemptNumber: attempt.attemptNumber,
      destination: attempt.destination,
      bindingSource: this.bindingSource,
    });

    const existingOperation = await this.prisma.callOperation.findUnique({
      where: {
        organizationId_operation_key: {
          organizationId: request.organizationId,
          operation: request.operation,
          key: request.idempotencyKey,
        },
      },
    });

    if (existingOperation) {
      const result = existingOperation.result as {
        readonly providerCallId?: string;
        readonly bindingSource?: string;
        readonly uncertain?: boolean;
      };
      if (
        existingOperation.attemptId !== attemptId ||
        existingOperation.fingerprintVersion !== request.fingerprintVersion ||
        existingOperation.fingerprint !== request.fingerprint
      ) {
        throw new Error('campaign_call_initiation_idempotency_conflict');
      }
      if (result?.uncertain) return this.uncertain(attemptId);
      if (!result?.providerCallId || result.bindingSource !== request.bindingSource) {
        throw new Error('campaign_call_initiation_operation_result_invalid');
      }
      return {
        status: 'initiated',
        attemptId,
        providerCallId: result.providerCallId,
        replayed: true,
      };
    }

    // A previous worker may already have contacted the provider. A missing
    // operation record cannot justify a second outbound initiation.
    if (claim.status === 'already_claimed') {
      return this.resultFromReconciliation(
        attemptId,
        await this.reconciliation.reconcileAttempt(request.organizationId, attemptId),
      );
    }

    try {
      return await this.prisma.$transaction(async (tx) => {
        const authorization = await this.dispatchGuard.authorize(tx, {
          organizationId: request.organizationId,
          campaignId: request.campaignId,
          recipientId: request.recipientId,
          attemptId,
          currency: 'UGX',
        });
        if (!authorization.ok) {
          await this.reconciliation.reconcileAttempt(request.organizationId, attemptId, tx);
          return {
            status: 'blocked',
            reason: authorization.reason,
            attemptId,
            reconciliationRequired: false,
          } as const;
        }

        const providerInvocationStarted = await this.reconciliation.beginProviderInvocation(
          request.organizationId,
          attemptId,
          tx,
        );
        if (!providerInvocationStarted) {
          // No provider call happened, so the reservation must not remain held.
          await releaseDispatchReservation(tx, request.organizationId, attemptId);
          return this.resultFromReconciliation(
            attemptId,
            await this.reconciliation.reconcileAttempt(request.organizationId, attemptId, tx),
          );
        }

        let providerCallId: string | undefined;
        try {
          const result = await this.voice.initiateCall({
            to: request.destination,
            callId: attemptId,
            organizationId: request.organizationId,
            idempotencyKey: request.idempotencyKey,
          });
          providerCallId = result.providerCallId;
        } catch {
          // A provider exception cannot prove that the provider did not accept the call.
        }

        const operation = {
          organizationId: request.organizationId,
          operation: request.operation,
          key: request.idempotencyKey,
          fingerprintVersion: request.fingerprintVersion,
          fingerprint: request.fingerprint,
          attemptId,
        };
        if (!providerCallId) {
          await tx.callOperation.create({ data: { ...operation, result: { uncertain: true } } });
          await this.markUnknown(tx, request.organizationId, attemptId);
          return this.uncertain(attemptId);
        }

        try {
          await bindCallbackSession(tx, request.bindingSource, providerCallId, request.organizationId, attemptId);
          const updated = await tx.callAttempt.updateMany({
            where: { organizationId: request.organizationId, id: attemptId, state: 'QUEUED' },
            data: { state: 'DIALING' },
          });
          if (updated.count !== 1) {
            await this.markUnknown(tx, request.organizationId, attemptId);
            return this.uncertain(attemptId);
          }
          await tx.callOperation.create({
            data: {
              ...operation,
              result: { providerCallId, bindingSource: request.bindingSource },
            },
          });
          await this.markConfirmed(tx, request.organizationId, attemptId);
        } catch {
          // A failed or ambiguous commit is never reported as a confirmed initiation.
          await this.markUnknown(tx, request.organizationId, attemptId).catch(() => undefined);
          return this.uncertain(attemptId);
        }

        return { status: 'initiated', attemptId, providerCallId, replayed: false };
      });
    } catch {
      // Any infrastructure failure before or during the guarded transaction is
      // conservative: no provider call can be proved to have been avoided, so
      // reconciliation remains required and the reservation is rolled back.
      return this.uncertain(attemptId);
    }
  }

  private async markUnknown(
    tx: Tx,
    organizationId: string,
    attemptId: string,
  ): Promise<void> {
    const updated = await tx.callInitiationReconciliation.updateMany({
      where: {
        organizationId,
        attemptId,
        status: 'INVOKING',
        reconciliationRequired: true,
      },
      data: { status: 'UNKNOWN', reconciliationRequired: true },
    });
    if (updated.count !== 1) throw new Error('call_initiation_reconciliation_transition_conflict');
  }

  private async markConfirmed(
    tx: Tx,
    organizationId: string,
    attemptId: string,
  ): Promise<void> {
    const updated = await tx.callInitiationReconciliation.updateMany({
      where: {
        organizationId,
        attemptId,
        status: 'INVOKING',
        reconciliationRequired: true,
      },
      data: { status: 'CONFIRMED', reconciliationRequired: false },
    });
    if (updated.count !== 1) throw new Error('call_initiation_reconciliation_transition_conflict');
  }

  private resultFromReconciliation(
    attemptId: string,
    result: Awaited<ReturnType<CallInitiationReconciliationService['reconcileAttempt']>>,
  ): InitiationResult {
    if (result.status === 'FAILED_BEFORE_PROVIDER') {
      return { status: 'failed_before_provider', attemptId, reconciliationRequired: false };
    }
    if (result.status === 'CONFIRMED') {
      throw new Error('call_initiation_operation_missing_for_confirmed_attempt');
    }
    return this.uncertain(attemptId);
  }

  private uncertain(attemptId: string): InitiationResult {
    return {
      status: 'uncertain',
      attemptId,
      outcome: 'unknown_provider_outcome',
      reconciliationRequired: true,
    };
  }
}

export { FakeVoiceAdapter };
