/**
 * Audit action vocabulary.
 *
 * The `action` column in `security_audit_events` is a `varchar`, not a Prisma
 * enum, on purpose: the set of audited actions grows with the product, and a new
 * audit action should not require a migration of a table that cannot be rewritten
 * (it is append-only, enforced by trigger).
 *
 * That flexibility has a cost - nothing forces a writer to use a known action -
 * so the values are listed here and `assertKnownAuditAction` rejects anything
 * else at the point of writing. A typo becomes a failed request rather than an
 * audit row nobody can query later.
 *
 * Naming: dotted, past tense, namespace first. `organization.member.role_changed`
 * says what happened to what, and sorts usefully.
 */

/** Audit actions written by RBAC-001. */
export const AUDIT_ACTIONS = [
  // Authentication and session lifecycle.
  'auth.sign_in.succeeded',
  'auth.sign_in.failed',
  'auth.sign_out',
  'auth.password_reset_requested',
  'auth.password_reset_completed',
  'auth.password_reset_token_reused',
  'auth.account_locked',
  'auth.account_deactivated',
  'auth.session_revoked',

  // Terms.
  'terms.accepted',

  // Organization profile.
  'organization.profile_updated',

  // Campaigns (RBAC-003). Campaign rows are tenant-owned; every mutation is
  // recorded against the organization that performed it.
  'campaign.created',
  'campaign.updated',
  'campaign.deleted',
  'billing.profile_updated',
  'billing.top_up_requested',
  'organization.owner.provisioned',
  'auth.owner_provisioned',
  'platform.campaign.emergency_stopped',
  'platform.operations_admin.provisioned',
  'platform.owner.bootstrapped',

  // Membership and invitations.
  'organization.member.invited',
  'organization.member.role_changed',
  'organization.member.removed',
  'organization.invitation.revoked',
  'organization.invitation.accepted',
  'organization.ownership.transferred',

  // Support lookup and diagnostics (RBAC-009). Read-only, but recorded: an
  // operator reading a customer's data is itself an event an auditor must be
  // able to answer for. The searched query string is never recorded - it can
  // contain customer-identifying input - only the fact that a search happened
  // and which non-sensitive filters it used.
  'platform.support.organization_searched',
  'platform.support.organization_viewed',
  'platform.support.diagnostics_viewed',
  'platform.support.user_searched',
  'platform.support.user_viewed',
  'platform.support.audit_viewed',

  // Technical diagnostics (RBAC-010). Read-only infrastructure facts - health,
  // provider and queue availability, log-storage availability, the platform
  // audit trail - but recorded like any other operator read, so "who was
  // looking at the platform's internals?" has an answer.
  'platform.technical.overview_viewed',
  'platform.technical.providers_viewed',
  'platform.technical.queues_viewed',
  'platform.technical.logs_viewed',
  'platform.technical.audit_viewed',

  // Read-only Admin / Auditor (RBAC-011). An auditor's read of platform
  // metadata or the audit trail is itself an event an auditor must be able to
  // answer for, exactly as support and technical reads are. The role mutates
  // nothing, so no mutation action is added for it.
  'platform.audit.overview_viewed',
  'platform.audit.organizations_viewed',
  'platform.audit.audit_viewed',

  // Authorization denials. A trail of successes alone cannot answer "was this an
  // attack?", so refusals are recorded too.
  'authorization.denied',
  'platform.access.denied',
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

const KNOWN_ACTIONS: ReadonlySet<string> = new Set<string>(AUDIT_ACTIONS);

/** Whether `action` is one this codebase knows how to interpret. */
export function isKnownAuditAction(action: string): action is AuditAction {
  return KNOWN_ACTIONS.has(action);
}

/**
 * Throws when `action` is not in the vocabulary.
 *
 * Called by the audit writer rather than trusted to callers, because the whole
 * point of the string column is that the database will not check it.
 */
export function assertKnownAuditAction(action: string): asserts action is AuditAction {
  if (!isKnownAuditAction(action)) {
    throw new Error(
      `Unknown audit action "${action}". Add it to AUDIT_ACTIONS in @truevine/auth ` +
        'so audit queries can rely on the vocabulary.',
    );
  }
}

/**
 * Keys that must never appear in audit metadata.
 *
 * The audit trail is read by support and platform staff and is retained
 * indefinitely, so it must not become a place secrets are copied into. The
 * writer checks metadata keys against this list.
 */
export const FORBIDDEN_AUDIT_METADATA_KEYS: ReadonlySet<string> = new Set([
  'accesstoken',
  'clientsecret',
  'connectionstring',
  'cardnumber',
  'cvv',
  'paymentcredentials',
  'password',
  'newpassword',
  'currentpassword',
  'passwordhash',
  'token',
  'tokenhash',
  'sessiontoken',
  'refreshtoken',
  'secret',
  'authorization',
  'cookie',
  'apikey',
  'privatekey',
  'credential',
  'dsn',
]);

/** Whether a metadata key is safe to record. */
export function isSafeAuditMetadataKey(key: string): boolean {
  return !FORBIDDEN_AUDIT_METADATA_KEYS.has(key.toLowerCase().replace(/[^a-z0-9]/g, ''));
}

/**
 * Whether a metadata object is safe to record.
 *
 * Checks normalized keys at every object depth and bounds JSON values.
 * Callers must still project safe values; this is not proof that arbitrary
 * free text cannot contain a secret.
 */
export function isSafeAuditMetadata(metadata: Readonly<Record<string, unknown>>): boolean {
  const seen = new Set<object>();
  const safe = (value: unknown, depth: number): boolean => {
    if (depth > 12) return false;
    if (value === null || typeof value === 'boolean') return true;
    if (typeof value === 'string') return value.length <= 2048;
    if (typeof value === 'number') return Number.isFinite(value);
    if (typeof value !== 'object' || seen.has(value)) return false;
    seen.add(value);
    const result = Array.isArray(value)
      ? value.length <= 100 && value.every((item) => safe(item, depth + 1))
      : Object.getPrototypeOf(value) === Object.prototype &&
        Object.entries(value).every(
          ([name, item]) => isSafeAuditMetadataKey(name) && safe(item, depth + 1),
        );
    seen.delete(value);
    return result;
  };
  return safe(metadata, 0);
}
