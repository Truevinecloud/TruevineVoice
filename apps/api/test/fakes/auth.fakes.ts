import type { SecurityTransaction, SecurityStores } from '../../src/auth/security-transaction.js';
/**
 * In-memory fakes for the authentication stores.
 *
 * Used by the unit suite so that authorization can be tested exhaustively
 * without PostgreSQL, exactly as AGENTS.md 13 requires. The E2E suite runs the
 * same assertions against the real database, where the constraints are the ones
 * actually doing the work.
 *
 * Every fake implements the **whole** interface. A partial fake would type-check
 * only if the interface were optional, and an optional security method is a
 * method somebody forgets.
 */

import type {
  AuditEventInput,
  AuditStore,
  AuthStore,
  IdentityAuditEventInput,
  InvitationRecord,
  MembershipChangeResult,
  MembershipRecord,
  NewInvitation,
  NewPasswordResetToken,
  NewSession,
  OrganizationRecord,
  OrganizationStore,
  PlatformRoleRecord,
  PlatformRoleStore,
  SessionRecord,
  UserRecord,
} from '../../src/auth/auth.store.js';
import type { MembershipRole, PlatformRole } from '../../src/auth/prisma-types.js';

/**
 * A mutable view of a record type.
 *
 * The production interfaces are `readonly` on purpose: a service must not be able
 * to mutate what a store handed it. A fake models a *database row*, which does
 * change, so it needs the writable shape. A mutable type is assignable to a
 * readonly one, so the fakes still satisfy the real interfaces.
 */
type Mutable<T> = { -readonly [K in keyof T]: T[K] };

/** A user row as the stores return it. */
export function aUser(overrides: Partial<UserRecord> = {}): Mutable<UserRecord> {
  return {
    id: 'user-1',
    email: 'owner@example.invalid',
    status: 'ACTIVE',
    // Not a usable hash; the unit suite never verifies a real password.
    passwordHash: '$argon2id$stub$notarealhash',
    failedLoginCount: 0,
    lockedUntil: null,
    passwordChangedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

/** A session record with every field filled in. */
export function aSession(overrides: Partial<NewSession> = {}): NewSession {
  return {
    id: `session-${sessionsCreated++}`,
    userId: 'user-1',
    tokenHash: 'a-token-hash-nobody-can-replay',
    previousTokenHash: null,
    expiresAt: new Date('2999-01-01T00:00:00Z'),
    userAgentHash: null,
    ipPrefix: '203.0.113.0/24',
    ...overrides,
  };
}

let sessionsCreated = 0;

export function aMembership(overrides: Partial<MembershipRecord> = {}): Mutable<MembershipRecord> {
  return {
    organizationId: 'org-1',
    userId: 'user-1',
    role: 'OWNER',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

export function anInvitation(overrides: Partial<InvitationRecord> = {}): Mutable<InvitationRecord> {
  return {
    organizationId: 'org-1',
    id: 'inv-1',
    email: 'invitee@example.invalid',
    role: 'VIEWER',
    tokenHash: 'invitation-hash',
    invitedByUserId: 'user-1',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    expiresAt: new Date('2999-01-01T00:00:00Z'),
    acceptedAt: null,
    revokedAt: null,
    ...overrides,
  };
}

/** An {@link AuthStore} backed by arrays. */
export class FakeAuthStore implements AuthStore {
  users: Mutable<UserRecord>[] = [];
  sessions: Array<{ session: NewSession; revokedAt: Date | null }> = [];
  resetTokens: Array<Mutable<NewPasswordResetToken & { usedAt: Date | null }>> = [];
  terms: Array<{ userId: string; termsVersion: string }> = [];
  touched: string[] = [];

  async findUserByEmail(email: string): Promise<UserRecord | undefined> {
    return this.users.find((user) => user.email === email);
  }

  async findUserById(id: string): Promise<UserRecord | undefined> {
    return this.users.find((user) => user.id === id);
  }

  async recordFailedSignIn(
    userId: string,
    limit: number,
    lockoutMs: number,
    now: Date,
  ): Promise<UserRecord> {
    const user = this.requireUser(userId);
    if (user.lockedUntil && user.lockedUntil > now) return user;
    user.failedLoginCount = user.lockedUntil ? 1 : user.failedLoginCount + 1;
    user.lockedUntil = user.failedLoginCount >= limit ? new Date(now.getTime() + lockoutMs) : null;
    return user;
  }

  async recordSuccessfulSignIn(userId: string): Promise<UserRecord> {
    const user = this.requireUser(userId);
    user.failedLoginCount = 0;
    user.lockedUntil = null;
    return user;
  }

  async createSession(session: NewSession): Promise<SessionRecord> {
    this.sessions.push({ session, revokedAt: null });

    // The created row carries the columns Prisma defaults: `previousTokenHash` is
    // supplied and `revokedAt` starts null. Returning the input shape instead
    // would make the fake a lie the real store does not tell.
    return {
      id: session.id,
      userId: session.userId,
      tokenHash: session.tokenHash,
      previousTokenHash: session.previousTokenHash,
      expiresAt: session.expiresAt,
      revokedAt: null,
    };
  }

  async findActiveSessionByTokenHash(
    tokenHash: string,
    now: Date,
  ): Promise<SessionRecord | undefined> {
    const entry = this.sessions.find(
      (candidate) =>
        candidate.session.tokenHash === tokenHash &&
        candidate.revokedAt === null &&
        candidate.session.expiresAt.getTime() > now.getTime(),
    );

    if (!entry) return undefined;

    return {
      id: entry.session.id,
      userId: entry.session.userId,
      tokenHash: entry.session.tokenHash,
      previousTokenHash: entry.session.previousTokenHash,
      expiresAt: entry.session.expiresAt,
      revokedAt: entry.revokedAt,
    };
  }

  async rotateSession(): Promise<void> {
    throw new Error('rotateSession is not exercised by the unit suite.');
  }

  async revokeSession(sessionId: string, _reason: string, now: Date): Promise<boolean> {
    const entry = this.sessions.find((candidate) => candidate.session.id === sessionId);
    if (!entry || entry.revokedAt !== null) return false;
    entry.revokedAt = now;
    return true;
  }

  async revokeAllSessionsForUser(userId: string, _reason: string, now: Date): Promise<void> {
    for (const entry of this.sessions) {
      if (entry.session.userId === userId) entry.revokedAt = now;
    }
  }

  async touchSession(sessionId: string, _now?: Date): Promise<void> {
    this.touched.push(sessionId);
  }

  async createPasswordResetToken(token: NewPasswordResetToken): Promise<void> {
    this.resetTokens.push({ ...token, usedAt: null });
  }

  async findPasswordResetTokenByHash(tokenHash: string) {
    return this.resetTokens.find((token) => token.tokenHash === tokenHash);
  }

  async markPasswordResetTokenUsed(id: string, now: Date): Promise<boolean> {
    const token = this.resetTokens.find((candidate) => candidate.id === id);
    if (!token || token.usedAt !== null) return false;
    token.usedAt = now;
    return true;
  }

  async revokeAllPasswordResetTokens(userId: string): Promise<void> {
    for (const token of this.resetTokens) {
      if (token.userId === userId) token.expiresAt = new Date(0);
    }
  }

  async setPasswordHash(userId: string, passwordHash: string, now: Date): Promise<void> {
    const user = this.requireUser(userId);
    user.passwordHash = passwordHash;
    user.passwordChangedAt = now;
  }

  async hasAcceptedTerms(userId: string, termsVersion: string): Promise<boolean> {
    return this.terms.some(
      (entry) => entry.userId === userId && entry.termsVersion === termsVersion,
    );
  }

  async recordTermsAcceptance(
    userId: string,
    termsVersion: string,
    _ipPrefix?: string | null,
  ): Promise<void> {
    this.terms.push({ userId, termsVersion });
  }

  async setUserSuspended(userId: string, suspended: boolean): Promise<void> {
    const user = this.requireUser(userId);
    user.status = suspended ? 'SUSPENDED' : 'ACTIVE';
    user.failedLoginCount = 0;
    user.lockedUntil = null;
  }

  private requireUser(userId: string): Mutable<UserRecord> {
    const user = this.users.find((candidate) => candidate.id === userId);
    if (!user) throw new Error(`No such user in the fake: ${userId}`);
    return user;
  }
}

/** An {@link OrganizationStore} backed by arrays. */
export class FakeOrganizationStore implements OrganizationStore {
  organizations: Mutable<OrganizationRecord>[] = [
    { id: 'org-1', slug: 'acme', name: 'Acme', suspendedAt: null },
  ];
  memberships: Mutable<MembershipRecord>[] = [];
  invitations: Mutable<InvitationRecord>[] = [];
  /** Every organization id passed to a method, for "was it scoped?" assertions. */
  scopedCalls: string[] = [];

  async findOrganizationById(organizationId: string) {
    return this.organizations.find((organization) => organization.id === organizationId);
  }

  async setOrganizationSuspended(organizationId: string, suspended: boolean): Promise<boolean> {
    const organization = this.organizations.find((entry) => entry.id === organizationId);
    if (!organization) return false;

    organization.suspendedAt = suspended ? new Date('2026-06-01T00:00:00Z') : null;

    return true;
  }

  async updateName(organizationId: string, name: string): Promise<OrganizationRecord> {
    const organization = this.organizations.find((entry) => entry.id === organizationId);
    if (!organization) throw new Error('No such organization');
    organization.name = name;
    return organization;
  }

  async listMembershipsForUser(userId: string) {
    return this.memberships
      .filter((membership) => membership.userId === userId)
      .map((membership) => ({
        ...membership,
        organization: this.requireOrganization(membership.organizationId),
      }));
  }

  async findMembership(organizationId: string, userId: string) {
    this.scopedCalls.push(organizationId);
    return this.memberships.find(
      (membership) => membership.organizationId === organizationId && membership.userId === userId,
    );
  }

  async listMemberships(organizationId: string) {
    this.scopedCalls.push(organizationId);
    return this.memberships.filter((membership) => membership.organizationId === organizationId);
  }

  async changeMembershipRole(
    organizationId: string,
    userId: string,
    role: MembershipRole,
  ): Promise<MembershipChangeResult> {
    const membership = this.memberships.find(
      (entry) => entry.organizationId === organizationId && entry.userId === userId,
    );

    if (!membership) return { ok: false, reason: 'not_found' };
    if (membership.role === 'OWNER') return { ok: false, reason: 'last_owner' };

    membership.role = role;
    return { ok: true };
  }

  async removeMembership(organizationId: string, userId: string): Promise<MembershipChangeResult> {
    const index = this.memberships.findIndex(
      (entry) => entry.organizationId === organizationId && entry.userId === userId,
    );

    if (index === -1) return { ok: false, reason: 'not_found' };

    const [removed] = this.memberships.splice(index, 1);

    if (removed?.role === 'OWNER' && this.ownerCount(organizationId) === 0) {
      this.memberships.splice(index, 0, removed);
      return { ok: false, reason: 'last_owner' };
    }

    return { ok: true };
  }

  async transferOwnership(
    organizationId: string,
    expectedCurrentOwnerId: string,
    newOwnerId: string,
  ): Promise<MembershipChangeResult> {
    const current = this.memberships.find(
      (entry) => entry.organizationId === organizationId && entry.userId === expectedCurrentOwnerId,
    );

    if (!current || current.role !== 'OWNER') return { ok: false, reason: 'not_found' };

    const target = this.memberships.find(
      (entry) => entry.organizationId === organizationId && entry.userId === newOwnerId,
    );

    if (!target) return { ok: false, reason: 'not_found' };

    target.role = 'OWNER';
    current.role = 'ADMIN';

    return { ok: true };
  }

  async findInvitationState(organizationId: string, id: string) {
    const row = this.invitations.find(
      (value) => value.organizationId === organizationId && value.id === id,
    );
    return row
      ? { role: row.role, acceptedAt: row.acceptedAt, revokedAt: row.revokedAt }
      : undefined;
  }
  async listInvitations(organizationId: string) {
    return this.invitations.filter((invitation) => invitation.organizationId === organizationId);
  }

  async findOutstandingInvitationByEmail(organizationId: string, email: string) {
    return this.invitations.filter(
      (invitation) =>
        invitation.organizationId === organizationId &&
        invitation.email === email &&
        invitation.acceptedAt === null &&
        invitation.revokedAt === null,
    );
  }

  async findInvitationByTokenHash(tokenHash: string) {
    return this.invitations.find((invitation) => invitation.tokenHash === tokenHash);
  }

  async createInvitation(invitation: NewInvitation): Promise<InvitationRecord> {
    const created = anInvitation({
      organizationId: invitation.organizationId,
      id: invitation.id,
      email: invitation.email,
      role: invitation.role,
      tokenHash: invitation.tokenHash,
      invitedByUserId: invitation.invitedByUserId,
      expiresAt: invitation.expiresAt,
    });

    this.invitations.push(created);
    return created;
  }

  async revokeInvitation(organizationId: string, invitationId: string, now: Date) {
    const invitation = this.invitations.find(
      (entry) => entry.organizationId === organizationId && entry.id === invitationId,
    );

    if (!invitation || invitation.acceptedAt !== null || invitation.revokedAt !== null) {
      return false;
    }

    invitation.revokedAt = now;
    return true;
  }

  async acceptInvitation(tokenHash: string, userId: string, now: Date) {
    const invitation = this.invitations.find((entry) => entry.tokenHash === tokenHash);

    if (
      !invitation ||
      invitation.acceptedAt !== null ||
      invitation.revokedAt !== null ||
      invitation.expiresAt.getTime() <= now.getTime()
    ) {
      return { ok: false };
    }

    if (
      !this.memberships.some(
        (entry) => entry.organizationId === invitation.organizationId && entry.userId === userId,
      )
    ) {
      this.memberships.push(
        aMembership({
          organizationId: invitation.organizationId,
          userId,
          role: invitation.role,
        }),
      );
    }

    invitation.acceptedAt = now;

    return { ok: true };
  }

  private ownerCount(organizationId: string): number {
    return this.memberships.filter(
      (membership) => membership.organizationId === organizationId && membership.role === 'OWNER',
    ).length;
  }

  private requireOrganization(id: string): OrganizationRecord {
    const organization = this.organizations.find((entry) => entry.id === id);
    if (!organization) throw new Error(`No such organization: ${id}`);
    return organization;
  }
}

/** A {@link PlatformRoleStore} with a single mutable assignment. */
export class FakePlatformRoleStore implements PlatformRoleStore {
  private assignment?: PlatformRoleRecord;

  constructor(assignment?: PlatformRoleRecord) {
    this.assignment = assignment;
  }

  async findPlatformRole(): Promise<PlatformRoleRecord | undefined> {
    return this.assignment;
  }

  grant(userId: string, role: PlatformRole): void {
    this.assignment = { userId, role, revokedAt: null };
  }

  setAssignment(record: PlatformRoleRecord): void {
    this.assignment = record;
  }
}

/** An {@link AuditStore} that records what it was asked to write. */
export class FakeAuditStore implements AuditStore {
  events: AuditEventInput[] = [];
  identityEvents: IdentityAuditEventInput[] = [];

  async record(event: AuditEventInput): Promise<void> {
    this.events.push(event);
  }

  async recordIdentity(event: IdentityAuditEventInput): Promise<void> {
    this.identityEvents.push(event);
  }

  actions(): readonly string[] {
    return [
      ...this.events.map((event) => event.action),
      ...this.identityEvents.map((event) => event.action),
    ];
  }
}

/** Creates a user plus an organization with them as owner. */
export function seedOwner(
  auth: FakeAuthStore,
  organizations: FakeOrganizationStore,
  overrides: { role?: MembershipRole; organizationId?: string } = {},
): UserRecord {
  const organizationId = overrides.organizationId ?? 'org-1';
  const user = aUser();

  auth.users.push(user);
  organizations.memberships.push(
    aMembership({ organizationId, userId: user.id, role: overrides.role ?? 'OWNER' }),
  );

  return user;
}

export class FakeSecurityTransaction implements SecurityTransaction {
  constructor(
    private readonly auth: FakeAuthStore,
    private readonly organizations: FakeOrganizationStore,
    private readonly audit: FakeAuditStore,
  ) {}
  async run<T>(work: (stores: SecurityStores) => Promise<T>): Promise<T> {
    const snapshots = [this.auth, this.organizations, this.audit].map((store) =>
      structuredClone({ ...store }),
    );
    try {
      return await work({
        auth: this.auth,
        organizations: this.organizations,
        audit: this.audit,
        lockUser: async () => {},
        lockOrganization: async () => {},
      });
    } catch (error) {
      [this.auth, this.organizations, this.audit].forEach((store, i) =>
        Object.assign(store, snapshots[i]),
      );
      throw error;
    }
  }
}
