/**
 * The read-only persistence contract behind RBAC-011 auditor views.
 *
 * Deliberately free of credential- and token-shaped fields and of customer
 * financial data: `passwordHash`, `tokenHash`, `walletEntry`, `topUpRequest`
 * and every billing field have no name here, so a store implementation cannot
 * return them and a service cannot leak them by forwarding a record. Redaction
 * is structural, not a filter someone must remember to apply.
 *
 * Everything is a read. There is no write method on this interface by
 * construction; the only writes this feature performs are audit rows, and those
 * go through {@link AuditStore}. An auditor therefore cannot modify or delete an
 * audit record through this surface - there is no method with which to try.
 */

/** Which of the two append-only trails an event was read from. */
export type AuditorAuditTrail = 'identity' | 'security';

/**
 * A platform-scope audit event, reduced to the fields an auditor may see.
 *
 * `metadata` is carried as the raw JSON the writers stored (already constrained
 * at write time by `isSafeAuditMetadata`), and projected through an allowlist in
 * the service before it is returned.
 */
export interface AuditorAuditEventRecord {
  readonly id: string;
  readonly trail: AuditorAuditTrail;
  readonly action: string;
  readonly outcome: 'SUCCESS' | 'DENIED';
  /** `null` for identity-trail rows; `PLATFORM` for platform security rows. */
  readonly scope: 'PLATFORM' | null;
  readonly targetType: string | null;
  readonly targetId: string | null;
  readonly occurredAt: Date;
  readonly actorUserId: string;
  readonly actorEmail: string;
  readonly metadata: unknown;
}

/** Organization metadata an auditor may see. Never tenant content or money. */
export interface AuditorOrganizationSummary {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly status: 'ACTIVE' | 'SUSPENDED';
  readonly createdAt: Date;
  readonly memberCount: number;
}

/** Position in the merged platform trail, resolved from a returned event. */
export interface AuditorAuditCursor {
  readonly trail: AuditorAuditTrail;
  readonly eventId: string;
}

export interface AuditorAuditTrailInput {
  readonly action?: string;
  readonly after?: AuditorAuditCursor;
  readonly limit: number;
}

export interface AuditorOrganizationInput {
  readonly afterSlug?: string;
  readonly limit: number;
}

export interface AuditorStore {
  /**
   * Platform operators' actions, newest first: every identity-trail event plus
   * the `PLATFORM`-scoped rows of `security_audit_events`.
   *
   * Organization-scoped security rows are excluded by the store query itself so
   * that cross-tenant content never reaches this trail - an auditor answers
   * "what happened to the platform?", never "what is in this customer's
   * account?".
   */
  platformAuditEvents(
    input: AuditorAuditTrailInput,
  ): Promise<readonly AuditorAuditEventRecord[]>;

  /**
   * Organization metadata only - identity, status and counts. No campaign
   * content, no billing profile, no wallet, no members. That is the support
   * diagnostics permission's job, and the auditor does not hold it.
   */
  organizationSummaries(
    input: AuditorOrganizationInput,
  ): Promise<readonly AuditorOrganizationSummary[]>;

  /** Count of organizations, for the overview. A count is not tenant content. */
  countOrganizations(): Promise<number>;

  /** Count of active platform role assignments, grouped by role. Roles only. */
  platformRoleCounts(): Promise<readonly { readonly role: string; readonly count: number }[]>;
}
