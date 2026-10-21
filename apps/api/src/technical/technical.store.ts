/**
 * The read-only persistence contract behind RBAC-010 technical diagnostics.
 *
 * One method, because the only data technical views read from the database is
 * the audit trail itself: health, provider availability, queue availability and
 * log-storage availability are live probes and honest declarations, not tables.
 *
 * Deliberately free of credential- and token-shaped fields, and there is no
 * write method by construction - the only writes technical views perform are
 * audit rows, which go through {@link AuditStore}.
 */

/** Which of the two append-only trails an event was read from. */
export type TechnicalAuditTrail = 'identity' | 'security';

export interface TechnicalAuditEventRecord {
  readonly id: string;
  readonly trail: TechnicalAuditTrail;
  readonly action: string;
  readonly outcome: 'SUCCESS' | 'DENIED';
  /** `null` for identity-trail rows, which belong to no organization. */
  readonly scope: 'ORGANIZATION' | 'PLATFORM' | null;
  readonly targetType: string | null;
  readonly targetId: string | null;
  readonly occurredAt: Date;
  readonly actorUserId: string;
  readonly actorEmail: string;
  readonly metadata: unknown;
}

/**
 * Position in the merged trail, resolved from a previously returned event.
 *
 * The trail discriminator is part of the cursor because the page spans two
 * tables: without it the same id could not be resolved unambiguously.
 */
export interface TechnicalAuditCursor {
  readonly trail: TechnicalAuditTrail;
  readonly eventId: string;
}

export interface TechnicalAuditTrailInput {
  readonly action?: string;
  readonly after?: TechnicalAuditCursor;
  readonly limit: number;
}

export interface TechnicalStore {
  /**
   * Platform operators' actions, newest first: every identity-trail event
   * plus the `PLATFORM`-scoped rows of `security_audit_events`.
   *
   * Organization-scoped security rows are excluded by the store itself so that
   * cross-tenant content never reaches this trail - a technical view answers
   * "what happened to the platform?", never "what is in this customer's
   * account?".
   */
  platformAuditEvents(
    input: TechnicalAuditTrailInput,
  ): Promise<readonly TechnicalAuditEventRecord[]>;
}
