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
  'platform.campaign.emergency_stopped',
  'platform.operations_admin.provisioned',

  // Membership and invitations.
  'organization.member.invited',
  'organization.member.role_changed',
  'organization.member.removed',
  'organization.invitation.revoked',
  'organization.invitation.accepted',
  'organization.ownership.transferred',

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
  return !FORBIDDEN_AUDIT_METADATA_KEYS.has(key.toLowerCase());
}

/**
 * Whether a metadata object is safe to record.
 *
 * Checks keys only. Values are written by this codebase's own services, and
 * inventing a deep content scanner here would be theatre: the real protection
 * is that callers never pass the secret in the first place, which is what the
 * audit-service tests assert for each writer.
 */
export function isSafeAuditMetadata(metadata: Readonly<Record<string, unknown>>): boolean {
  return Object.keys(metadata).every(isSafeAuditMetadataKey);
}
