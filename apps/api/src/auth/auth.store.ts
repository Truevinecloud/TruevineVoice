/**
 * Narrow persistence contracts for authentication and authorization.
 *
 * Declared structurally rather than taking a Prisma client, for the same reason
 * `QueryableClient` is declared structurally in `@truevine/database`: services
 * must be unit-testable without a database, and no consumer should be handed the
 * full ORM surface when it needs six queries.
 *
 * Every method that returns tenant-owned data takes an explicit
 * `organizationId`. There is no method here that can be called without one, so a
 * service cannot accidentally build an unscoped query.
 */

import type { MembershipRole, PlatformRole } from './prisma-types.js';

/** A user as the authorization layer needs it. Never includes the password hash. */
export interface UserRecord {
  readonly id: string;
  readonly email: string;
  readonly status: 'ACTIVE' | 'SUSPENDED';
  readonly passwordHash: string;
  readonly failedLoginCount: number;
  readonly lockedUntil: Date | null;
  readonly passwordChangedAt: Date;
}

/** A session row. */
export interface SessionRecord {
  readonly id: string;
  readonly userId: string;
  readonly tokenHash: string;
  readonly previousTokenHash: string | null;
  readonly expiresAt: Date;
  readonly revokedAt: Date | null;
}

/** An organization profile. */
export interface OrganizationRecord {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  /**
   * When the organization was suspended, or `null` while active.
   *
   * `OrganizationGuard` reads this on the same lookup that resolves the caller's
   * membership, so a suspended tenant costs no extra round trip.
   */
  readonly suspendedAt: Date | null;
}

/** A principal's standing in one organization. */
export interface MembershipRecord {
  readonly organizationId: string;
  readonly userId: string;
  readonly role: MembershipRole;
  readonly createdAt: Date;
}

/** An outstanding invitation. */
export interface InvitationRecord {
  readonly organizationId: string;
  readonly id: string;
  readonly email: string;
  readonly role: MembershipRole;
  readonly tokenHash: string;
  readonly invitedByUserId: string;
  readonly createdAt: Date;
  readonly expiresAt: Date;
  readonly acceptedAt: Date | null;
  readonly revokedAt: Date | null;
}

/** What to create a session row with. */
export interface NewSession {
  readonly id: string;
  readonly userId: string;
  readonly tokenHash: string;
  readonly previousTokenHash: string | null;
  readonly expiresAt: Date;
  readonly userAgentHash: string | null;
  readonly ipPrefix: string | null;
}

/** What to create a password-reset token with. */
export interface NewPasswordResetToken {
  readonly id: string;
  readonly userId: string;
  readonly tokenHash: string;
  readonly expiresAt: Date;
}

/** What to create an invitation with. */
export interface NewInvitation {
  readonly organizationId: string;
  readonly id: string;
  readonly email: string;
  readonly role: MembershipRole;
  readonly tokenHash: string;
  readonly invitedByUserId: string;
  readonly expiresAt: Date;
}

/** Input for creating a user. */
export interface NewUser {
  readonly id: string;
  readonly email: string;
  readonly passwordHash: string;
}

/** Input for creating an organization together with its first owner. */
export interface NewOrganization {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
}

/** Why a membership change was refused. */
export type MembershipChangeFailure = 'not_found' | 'last_owner' | 'not_permitted';

/** Outcome of a membership mutation. */
export type MembershipChangeResult =
  { readonly ok: true } | { readonly ok: false; readonly reason: MembershipChangeFailure };

/**
 * Persistence for authentication.
 *
 * All lookups are by normalised email or by opaque identifier. There is
 * deliberately no "find by email and password": verification needs the stored
 * hash, and a store method that took a plaintext password would put that
 * decision in the wrong layer.
 */
export interface AuthStore {
  findUserByEmail(email: string): Promise<UserRecord | undefined>;
  findUserById(id: string): Promise<UserRecord | undefined>;

  /** Records a failed sign-in and returns the user with its updated counters. */
  recordFailedSignIn(userId: string): Promise<UserRecord>;
  /** Clears the failure counter and lock after a successful sign-in. */
  recordSuccessfulSignIn(userId: string): Promise<UserRecord>;

  createSession(session: NewSession): Promise<SessionRecord>;
  /** Looks up an active session by digest. Revoked and expired rows are excluded. */
  findActiveSessionByTokenHash(tokenHash: string, now: Date): Promise<SessionRecord | undefined>;
  /**
   * Rotates a session digest in place.
   *
   * Storing the superseded digest alongside the new one is what makes reuse
   * detectable: a stolen token that is replayed after the legitimate client has
   * refreshed is recognised instead of being accepted.
   */
  rotateSession(
    sessionId: string,
    newTokenHash: string,
    previousTokenHash: string,
    expiresAt: Date,
  ): Promise<void>;
  revokeSession(sessionId: string, reason: string, now: Date): Promise<void>;
  /** Revokes every live session for a user, for example after a password change. */
  revokeAllSessionsForUser(userId: string, reason: string, now: Date): Promise<void>;
  touchSession(sessionId: string, now: Date): Promise<void>;

  createPasswordResetToken(token: NewPasswordResetToken): Promise<void>;
  findPasswordResetTokenByHash(tokenHash: string): Promise<
    | {
        readonly id: string;
        readonly userId: string;
        readonly expiresAt: Date;
        readonly usedAt: Date | null;
      }
    | undefined
  >;
  /** Marks a reset token used. Returns false when it was already used. */
  markPasswordResetTokenUsed(id: string, now: Date): Promise<boolean>;
  /** Invalidates every outstanding reset token for a user. */
  revokeAllPasswordResetTokens(userId: string): Promise<void>;

  setPasswordHash(userId: string, passwordHash: string, now: Date): Promise<void>;

  hasAcceptedTerms(userId: string, termsVersion: string): Promise<boolean>;
  recordTermsAcceptance(
    userId: string,
    termsVersion: string,
    ipPrefix: string | null,
  ): Promise<void>;

  /**
   * Suspends or reactivates an account.
   *
   * Reversible by design: this sets a status, it never removes a row. A deleted
   * user would break every audit reference to them, and the append-only trigger
   * would refuse the delete anyway (ADR 0009).
   */
  setUserSuspended(userId: string, suspended: boolean): Promise<void>;
}

/** Persistence for organization profiles, memberships and invitations. */
export interface OrganizationStore {
  findOrganizationById(organizationId: string): Promise<OrganizationRecord | undefined>;

  /**
   * Suspends or reactivates an organization.
   *
   * Reversible: sets or clears `suspended_at`. Nothing is deleted, because
   * deleting an organization with audit events is refused by the append-only
   * trigger, and because a removed tenant cannot be brought back.
   */
  setOrganizationSuspended(organizationId: string, suspended: boolean): Promise<boolean>;

  /**
   * Renames an organization.
   *
   * `slug` is intentionally not part of this method: it is the stable public
   * identifier, and making it mutable through the API would break customer
   * bookmarks and any provider reference captured against it.
   */
  updateName(organizationId: string, name: string): Promise<OrganizationRecord>;

  /**
   * Every membership the user holds, across all organizations.
   *
   * The one method here that is deliberately not organization-scoped: it exists
   * to build `GET /me`, whose whole job is to answer "which organizations can
   * this person act in?". It returns memberships, never organization data, and
   * every organization-scoped read still takes an explicit organization id.
   */
  listMembershipsForUser(
    userId: string,
  ): Promise<readonly (MembershipRecord & { readonly organization: OrganizationRecord })[]>;

  /**
   * A principal's membership in one organization.
   *
   * Both arguments are required, so no caller can ask "what can this user do
   * anywhere?" and get an unscoped answer.
   */
  findMembership(organizationId: string, userId: string): Promise<MembershipRecord | undefined>;

  listMemberships(organizationId: string): Promise<readonly MembershipRecord[]>;

  /**
   * Changes a member's role.
   *
   * Returns `last_owner` rather than throwing when the change would leave the
   * organization without an owner. The count is taken and the update applied in
   * one transaction; doing it in the service would be a check-then-act race.
   */
  changeMembershipRole(
    organizationId: string,
    userId: string,
    role: MembershipRole,
  ): Promise<MembershipChangeResult>;

  /** Removes a member, refusing to remove the last owner. */
  removeMembership(organizationId: string, userId: string): Promise<MembershipChangeResult>;

  /**
   * Moves ownership from one member to another.
   *
   * One transaction, and `expectedCurrentOwnerId` makes it a compare-and-set: if
   * two owners act at once, exactly one succeeds rather than the second silently
   * overwriting the first.
   */
  transferOwnership(
    organizationId: string,
    expectedCurrentOwnerId: string,
    newOwnerId: string,
  ): Promise<MembershipChangeResult>;

  listInvitations(organizationId: string): Promise<readonly InvitationRecord[]>;
  findOutstandingInvitationByEmail(email: string): Promise<readonly InvitationRecord[]>;
  findInvitationByTokenHash(tokenHash: string): Promise<InvitationRecord | undefined>;
  createInvitation(invitation: NewInvitation): Promise<InvitationRecord>;
  revokeInvitation(organizationId: string, invitationId: string, now: Date): Promise<boolean>;
  /** Accepts an invitation, creating the membership. Idempotent per token. */
  acceptInvitation(tokenHash: string, userId: string, now: Date): Promise<{ readonly ok: boolean }>;
}

/** A principal's standing in the Truevine platform, if any. */
export interface PlatformRoleRecord {
  readonly userId: string;
  readonly role: PlatformRole;
  readonly revokedAt: Date | null;
}

/** Persistence for platform role assignments. */
export interface PlatformRoleStore {
  findPlatformRole(userId: string): Promise<PlatformRoleRecord | undefined>;
}

/** A row destined for the append-only organization-scoped audit trail. */
export interface AuditEventInput {
  readonly organizationId: string;
  readonly actorUserId: string;
  readonly action: string;
  readonly scope: 'ORGANIZATION' | 'PLATFORM';
  readonly outcome: 'SUCCESS' | 'DENIED';
  readonly targetType?: string;
  readonly targetId?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/** A row destined for the append-only identity-scoped audit trail. */
export interface IdentityAuditEventInput {
  readonly actorUserId: string;
  readonly action: string;
  readonly outcome: 'SUCCESS' | 'DENIED';
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/**
 * Append-only audit writer.
 *
 * There is no update and no delete method, by construction. The database
 * enforces the same thing with a trigger; omitting them here means the
 * application cannot offer to do it even by mistake.
 *
 * Two methods, two tables. Organization events are tenant-scoped; identity
 * events (sign-in, password reset, terms) are not, because "Alice signed in" does
 * not belong to any organization. Forcing identity events into the organization
 * trail would mean either a nullable tenant column - breaking the ADR 0006 key
 * rule - or one row per membership, which would under-report exactly when it
 * matters most.
 */
export interface AuditStore {
  record(event: AuditEventInput): Promise<void>;
  recordIdentity(event: IdentityAuditEventInput): Promise<void>;
}

/** Creates a user and an organization, making the user its first owner. */
export interface ProvisioningStore {
  createUserWithOrganization(
    user: NewUser,
    organization: NewOrganization,
  ): Promise<{ readonly user: UserRecord; readonly organization: OrganizationRecord }>;
}
