export type CallInitiationReconciliationStatus =
  | 'NOT_STARTED'
  | 'INVOKING'
  | 'CONFIRMED'
  | 'FAILED_BEFORE_PROVIDER'
  | 'UNKNOWN';

export type CallInitiationReconciliationResult =
  | {
      readonly status: 'CONFIRMED';
      readonly outcome: 'confirmed_initiation';
      readonly reconciliationRequired: false;
    }
  | {
      readonly status: 'FAILED_BEFORE_PROVIDER';
      readonly outcome: 'confirmed_failure_before_provider';
      readonly reconciliationRequired: false;
    }
  | {
      readonly status: 'UNKNOWN';
      readonly outcome: 'unknown_provider_outcome';
      readonly reconciliationRequired: true;
    };

type ReconciliationRecord = {
  readonly attemptId: string;
  readonly status: CallInitiationReconciliationStatus;
  readonly reconciliationRequired: boolean;
};

type ReconciliationDelegate = {
  findMany(input: unknown): Promise<ReconciliationRecord[]>;
  findUnique(input: unknown): Promise<ReconciliationRecord | null>;
  updateMany(input: unknown): Promise<{ count: number }>;
};

export type ReconciliationClient = {
  readonly callInitiationReconciliation: ReconciliationDelegate;
};

export class CallInitiationReconciliationService {
  constructor(private readonly prisma: ReconciliationClient) {}

  async listRequired(organizationId: string, limit = 100): Promise<ReconciliationRecord[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
      throw new Error('call_initiation_reconciliation_invalid_limit');
    }
    return this.prisma.callInitiationReconciliation.findMany({
      where: { organizationId, reconciliationRequired: true },
      orderBy: [{ updatedAt: 'asc' }, { attemptId: 'asc' }],
      take: limit,
      select: { attemptId: true, status: true, reconciliationRequired: true },
    });
  }

  async beginProviderInvocation(
    organizationId: string,
    attemptId: string,
    client: ReconciliationClient = this.prisma,
  ): Promise<boolean> {
    const result = await client.callInitiationReconciliation.updateMany({
      where: {
        organizationId,
        attemptId,
        status: 'NOT_STARTED',
        reconciliationRequired: true,
      },
      data: { status: 'INVOKING', reconciliationRequired: true },
    });
    return result.count === 1;
  }

  async reconcileAttempt(
    organizationId: string,
    attemptId: string,
    client: ReconciliationClient = this.prisma,
  ): Promise<CallInitiationReconciliationResult> {
    const notStarted = await client.callInitiationReconciliation.updateMany({
      where: {
        organizationId,
        attemptId,
        status: 'NOT_STARTED',
        reconciliationRequired: true,
      },
      data: { status: 'FAILED_BEFORE_PROVIDER', reconciliationRequired: false },
    });
    if (notStarted.count === 1) {
      return {
        status: 'FAILED_BEFORE_PROVIDER',
        outcome: 'confirmed_failure_before_provider',
        reconciliationRequired: false,
      };
    }

    const invoking = await client.callInitiationReconciliation.updateMany({
      where: {
        organizationId,
        attemptId,
        status: 'INVOKING',
        reconciliationRequired: true,
      },
      data: { status: 'UNKNOWN', reconciliationRequired: true },
    });
    if (invoking.count === 1) {
      return {
        status: 'UNKNOWN',
        outcome: 'unknown_provider_outcome',
        reconciliationRequired: true,
      };
    }

    const record = await client.callInitiationReconciliation.findUnique({
      where: { organizationId_attemptId: { organizationId, attemptId } },
      select: { attemptId: true, status: true, reconciliationRequired: true },
    });
    if (!record) throw new Error('call_initiation_reconciliation_missing');
    return this.toResult(record);
  }

  private toResult(record: ReconciliationRecord): CallInitiationReconciliationResult {
    if (record.status === 'CONFIRMED' && !record.reconciliationRequired) {
      return {
        status: 'CONFIRMED',
        outcome: 'confirmed_initiation',
        reconciliationRequired: false,
      };
    }
    if (record.status === 'FAILED_BEFORE_PROVIDER' && !record.reconciliationRequired) {
      return {
        status: 'FAILED_BEFORE_PROVIDER',
        outcome: 'confirmed_failure_before_provider',
        reconciliationRequired: false,
      };
    }
    if (record.status === 'UNKNOWN' && record.reconciliationRequired) {
      return {
        status: 'UNKNOWN',
        outcome: 'unknown_provider_outcome',
        reconciliationRequired: true,
      };
    }
    throw new Error('call_initiation_reconciliation_invalid_state');
  }
}
