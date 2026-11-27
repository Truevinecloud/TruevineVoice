export type ClaimResult =
  | { readonly status: 'claimed'; readonly attemptId: string }
  | { readonly status: 'already_claimed'; readonly attemptId: string }
  | { readonly status: 'already_completed'; readonly attemptId: string }
  | { readonly status: 'missing_execution' }
  | { readonly status: 'organization_mismatch' }
  | { readonly status: 'ineligible_recipient' }
  | { readonly status: 'cancelled' }
  | { readonly status: 'paused' }
  | { readonly status: 'retryable_conflict' };

export interface ClaimInput {
  readonly organizationId: string;
  readonly campaignId: string;
  readonly recipientId: string;
}

import { Inject } from '@nestjs/common';
import { dispatchVerdict } from '../reliability/dispatch-state.js';
import { DATABASE_CLIENT } from '../tokens.js';

type Tx = {
  campaignExecution: {
    findUnique(input: unknown): Promise<Record<string, unknown> | null>;
  };
  campaign: {
    findUnique(input: unknown): Promise<Record<string, unknown> | null>;
  };
  campaignRecipient: {
    findUnique(input: unknown): Promise<Record<string, unknown> | null>;
  };
  callAttempt: {
    findFirst(input: unknown): Promise<Record<string, unknown> | null>;
    create(input: unknown): Promise<Record<string, unknown>>;
  };
  callInitiationReconciliation: {
    create(input: unknown): Promise<Record<string, unknown>>;
  };
  $transaction<T>(work: (tx: Tx) => Promise<T>): Promise<T>;
};

export class CampaignExecutionClaimService {
  constructor(@Inject(DATABASE_CLIENT) private readonly prisma: Tx) {}

  async claim(input: ClaimInput): Promise<ClaimResult> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const execution = await tx.campaignExecution.findUnique({
          where: {
            organizationId_campaignId: {
              organizationId: input.organizationId,
              campaignId: input.campaignId,
            },
          },
        });
        if (!execution) return { status: 'missing_execution' };

        const campaign = await tx.campaign.findUnique({
          where: {
            organizationId_id: {
              organizationId: input.organizationId,
              id: input.campaignId,
            },
          },
        });
        if (!campaign || campaign.organizationId !== input.organizationId) {
          return { status: 'organization_mismatch' };
        }
        const verdict = dispatchVerdict({
          status: campaign.status,
          dispatchState: campaign.dispatchState,
          emergencyStoppedAt: campaign.emergencyStoppedAt,
        });
        if (verdict === 'cancelled') return { status: 'cancelled' };
        if (verdict === 'paused') return { status: 'paused' };
        if (verdict === 'not_active') return { status: 'missing_execution' };

        const recipient = await tx.campaignRecipient.findUnique({
          where: {
            organizationId_id: {
              organizationId: input.organizationId,
              id: input.recipientId,
            },
          },
        });
        if (!recipient || recipient.organizationId !== input.organizationId) {
          return { status: 'ineligible_recipient' };
        }

        const existing = await tx.callAttempt.findFirst({
          where: {
            organizationId: input.organizationId,
            executionId: execution.id,
            recipientId: recipient.id,
          },
        });
        if (existing) {
          if (existing.state === 'COMPLETED' || existing.state === 'ANSWERED') {
            return { status: 'already_completed', attemptId: String(existing.id) };
          }
          return { status: 'already_claimed', attemptId: String(existing.id) };
        }

        let attempt: Record<string, unknown>;
        try {
          attempt = await tx.callAttempt.create({
            data: {
              organizationId: input.organizationId,
              campaignId: input.campaignId,
              executionId: execution.id,
              recipientId: recipient.id,
              destination: recipient.destination,
              attemptNumber: 1,
              state: 'QUEUED',
            },
          });
        } catch {
          throw new Error('claim_create_conflict');
        }
        await tx.callInitiationReconciliation.create({
          data: {
            organizationId: input.organizationId,
            attemptId: String(attempt.id),
            status: 'NOT_STARTED',
            reconciliationRequired: true,
          },
        });
        return { status: 'claimed', attemptId: String(attempt.id) };
      });
    } catch {
      const existing = await this.prisma.callAttempt.findFirst({
        where: {
          organizationId: input.organizationId,
          campaignId: input.campaignId,
          recipientId: input.recipientId,
        },
      });
      if (existing) {
        if (existing.state === 'COMPLETED' || existing.state === 'ANSWERED') {
          return { status: 'already_completed', attemptId: String(existing.id) };
        }
        return { status: 'already_claimed', attemptId: String(existing.id) };
      }
      return { status: 'retryable_conflict' };
    }
  }
}