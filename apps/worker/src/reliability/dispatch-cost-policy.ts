/**
 * W6-01 pre-paid-work cost policy boundary.
 *
 * There is no approved tariff in this repository. Domain and pricing code must
 * not invent one, so production has no implementation and fails closed. The
 * isolated acceptance environment injects a synthetic fixed reserve; a real
 * approved policy can be supplied later without changing the dispatch guard.
 */

export interface DispatchCostInput {
  readonly organizationId: string;
  readonly campaignId: string;
  readonly recipientId: string;
  readonly attemptId: string;
  readonly currency: 'UGX';
}

export interface DispatchCostReservation {
  readonly amountMinor: bigint;
  readonly currency: 'UGX';
  /** Identifies which approved policy produced the reserve, for audit evidence. */
  readonly policyVersion: string;
}

export interface DispatchCostPolicy {
  reserve(input: DispatchCostInput): Promise<DispatchCostReservation | null>;
}

export const DISPATCH_COST_POLICY = Symbol('DISPATCH_COST_POLICY');

/** Production default: no approved tariff means no paid provider work. */
export class FailClosedDispatchCostPolicy implements DispatchCostPolicy {
  async reserve(): Promise<null> {
    return null;
  }
}

/** Synthetic, non-production policy for isolated fake-provider acceptance only. */
export class SyntheticDispatchCostPolicy implements DispatchCostPolicy {
  constructor(private readonly amountMinor: bigint) {
    if (!Number.isSafeInteger(Number(amountMinor)) || amountMinor < 0n) {
      throw new Error('Synthetic dispatch reserve must be a non-negative safe integer.');
    }
  }

  async reserve(): Promise<DispatchCostReservation> {
    return {
      amountMinor: this.amountMinor,
      currency: 'UGX',
      policyVersion: 'w601-synthetic-fixed',
    };
  }
}
