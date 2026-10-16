/**
 * Organization profile, membership, invitations and ownership.
 *
 * Every method takes the organization id as an argument and the caller as
 * another. Neither comes from the request body. The guard has already proved the
 * caller holds a membership in that organization and holds the permission being
 * exercised; this service then applies the rules that are about the *content* of
 * the change rather than about reaching it.
 *
 * The delegation rule lives here, not in the guard. The guard answers "may this
 * person reach this endpoint?"; this answers "may this person grant this role?" -
 * a different question, and one the permission set alone cannot express.
 */

import { randomUUID } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import {
  AuthError,
  INVITATION_TTL_MS,
  assertKnownAuditAction,
  canDelegate,
  cannotDelegate,
  cannotRemoveLastOwner,
  checkEmail,
  delegableRoles,
  generateToken,
  hashToken,
  isSafeAuditMetadata,
  type OrganizationPermission,
  type OrganizationRole,
} from '@truevine/auth';

import type {
  AuditStore,
  AuthStore,
  InvitationRecord,
  MembershipRecord,
  OrganizationRecord,
  OrganizationStore,
} from '../auth/auth.store.js';
import type { MembershipRole } from '../auth/prisma-types.js';
import { invitationMessage, type EmailSender } from '@truevine/messaging';

import {
  AUDIT_STORE,
  AUTH_STORE,
  EMAIL_SENDER,
  ORGANIZATION_STORE,
  TERMS_VERSION,
  WEB_PUBLIC_URL,
} from '../auth/tokens.js';

/** A member as returned to a client. Never includes the password hash. */
export interface MemberView {
  readonly userId: string;
  readonly email: string;
  readonly role: OrganizationRole;
  readonly joinedAt: string;
}

/** An organization profile as returned to a client. */
export interface OrganizationView {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
}

/** An invitation as returned to a client. Never includes the token. */
export interface InvitationView {
  readonly id: string;
  readonly email: string;
  readonly role: OrganizationRole;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly acceptedAt: string | null;
  readonly revokedAt: string | null;
  readonly outstanding: boolean;
}

/** One organization the signed-in user belongs to, with what they may do in it. */
export interface MembershipSummary {
  readonly organizationId: string;
  readonly organizationSlug: string;
  readonly organizationName: string;
  readonly role: OrganizationRole;
  readonly permissions: readonly OrganizationPermission[];
}

/** What `GET /me` returns. Drives permission-aware navigation in the client. */
export interface MeView {
  readonly userId: string;
  readonly email: string;
  readonly platformRole: string | null;
  readonly termsVersion: string;
  readonly termsAccepted: boolean;
  readonly memberships: readonly MembershipSummary[];
}

@Injectable()
export class OrganizationsService {
  constructor(
    @Inject(ORGANIZATION_STORE) private readonly organizationStore: OrganizationStore,
    @Inject(AUTH_STORE) private readonly authStore: AuthStore,
    @Inject(AUDIT_STORE) private readonly auditStore: AuditStore,
    @Inject(EMAIL_SENDER) private readonly emailSender: EmailSender,
    @Inject(WEB_PUBLIC_URL) private readonly webPublicUrl: string,
    @Inject(TERMS_VERSION) private readonly termsVersion: string,
  ) {}

  /** Reads the organization profile. */
  async getProfile(organizationId: string): Promise<OrganizationView> {
    const organization = await this.organizationStore.findOrganizationById(organizationId);

    // Unreachable through a guarded route, because the guard proved a membership
    // exists, which requires the organization to exist. Refused rather than
    // crashed on anyway.
    if (!organization) {
      throw new AuthError('organization_membership_required', 'Organization not found.', 404);
    }

    return organization;
  }

  /**
   * Renames the organization.
   *
   * `slug` is deliberately not editable: it is the stable public identifier, and
   * changing it breaks customer bookmarks and provider references captured
   * against it.
   */
  async updateProfile(
    organizationId: string,
    actorUserId: string,
    name: string,
  ): Promise<OrganizationView> {
    const trimmed = name.trim();

    if (trimmed.length === 0 || trimmed.length > 200) {
      throw new AuthError('invalid_email', 'Organization name must be 1 to 200 characters.', 400);
    }

    const updated = await this.organizationStore.updateName(organizationId, trimmed);

    await this.audit(organizationId, actorUserId, 'organization.profile_updated', 'SUCCESS', {
      organizationId,
    });

    return updated;
  }

  /** Lists members, with their emails resolved from the user table. */
  async listMembers(organizationId: string): Promise<readonly MemberView[]> {
    const memberships = await this.organizationStore.listMemberships(organizationId);

    return Promise.all(
      memberships.map(async (membership) => {
        const user = await this.authStore.findUserById(membership.userId);

        return {
          userId: membership.userId,
          // A membership cannot exist without a user (foreign key), so a missing
          // user is unreachable; the fallback keeps a type error from becoming a
          // silent `undefined` in an API response.
          email: user?.email ?? '',
          role: membership.role,
          joinedAt: membership.createdAt.toISOString(),
        };
      }),
    );
  }

  /**
   * Grants or changes a member's role.
   *
   * The delegation rule is enforced here, not merely checked: `canDelegate`
   * refuses `OWNER`, which means **no role change can create an owner**. The only
   * way to transfer ownership is {@link transferOwnership}.
   */
  async changeMemberRole(
    organizationId: string,
    actor: { readonly userId: string; readonly role: OrganizationRole },
    targetUserId: string,
    nextRole: OrganizationRole,
  ): Promise<void> {
    if (!canDelegate(actor.role, nextRole)) throw cannotDelegate();

    // Removing your own administrative authority while keeping your membership
    // would leave an account that can sign in and see a dashboard it can do
    // nothing with, and nobody would have invited them back.
    if (targetUserId === actor.userId && actor.role !== nextRole) {
      throw new AuthError(
        'cannot_delegate_beyond_own_authority',
        'You cannot change your own role.',
        409,
      );
    }

    const result = await this.organizationStore.changeMembershipRole(
      organizationId,
      targetUserId,
      nextRole as MembershipRole,
    );

    if (!result.ok) this.throwForMembershipFailure(result.reason);

    await this.audit(organizationId, actor.userId, 'organization.member.role_changed', 'SUCCESS', {
      organizationId,
      targetUserId,
      role: nextRole,
    });
  }

  /** Removes a member, refusing to remove the last owner. */
  async removeMember(
    organizationId: string,
    actor: { readonly userId: string; readonly role: OrganizationRole },
    targetUserId: string,
  ): Promise<void> {
    if (targetUserId === actor.userId) {
      throw new AuthError(
        'cannot_delegate_beyond_own_authority',
        'You cannot remove yourself.',
        409,
      );
    }

    // Only a role that can administer membership may remove one, and a role that
    // can remove a member can also name the roles that are delegable - so the
    // target cannot be someone whose authority exceeds the actor's.
    if (!canDelegate(actor.role, 'ADMIN') && actor.role !== 'OWNER') {
      throw cannotDelegate();
    }

    const result = await this.organizationStore.removeMembership(organizationId, targetUserId);

    if (!result.ok) this.throwForMembershipFailure(result.reason);

    await this.audit(organizationId, actor.userId, 'organization.member.removed', 'SUCCESS', {
      organizationId,
      targetUserId,
    });
  }

  /**
   * Invites somebody into the organization.
   *
   * Refuses an `OWNER` invitation outright: creating an owner is a transfer, not
   * an invitation, and conflating them would produce a second owner without the
   * deliberate act the owner role is supposed to require.
   */
  async invite(
    organizationId: string,
    actor: { readonly userId: string; readonly role: OrganizationRole },
    email: string,
    role: OrganizationRole,
  ): Promise<InvitationView> {
    if (role === 'OWNER') throw cannotDelegate();
    if (!canDelegate(actor.role, role)) throw cannotDelegate();

    const normalized = checkEmail(email);

    if (!normalized.ok) {
      throw new AuthError('invalid_email', 'That email address is not valid.', 400);
    }

    const outstanding = await this.organizationStore.findOutstandingInvitationByEmail(
      normalized.value,
    );

    if (outstanding.some((invitation) => invitation.organizationId === organizationId)) {
      throw new AuthError('email_already_registered', 'An invitation is already outstanding.', 409);
    }

    const raw = generateToken();
    const created = await this.organizationStore.createInvitation({
      organizationId,
      id: randomUUID(),
      email: normalized.value,
      role: role as MembershipRole,
      // Only the digest is stored. The emailed link is the sole copy of the raw
      // token, so a database disclosure cannot be used to join an organization.
      tokenHash: hashToken(raw),
      invitedByUserId: actor.userId,
      expiresAt: new Date(Date.now() + INVITATION_TTL_MS),
    });

    await this.audit(organizationId, actor.userId, 'organization.member.invited', 'SUCCESS', {
      organizationId,
      email: normalized.value,
      role,
    });

    await this.sendInvitationEmail(created, normalized.value, role, raw);

    return this.toInvitationView(created);
  }

  /**
   * Emails an invitation link containing the **raw** token.
   *
   * The raw token exists only here and in the email body; the database holds
   * only its digest. That is what makes a database disclosure useless for
   * joining an organization.
   *
   * A delivery failure is swallowed after the audit row is written. The
   * invitation exists in the database and the inviter can revoke it; reporting a
   * 500 would suggest nothing was created, which is untrue, and would leave them
   * inviting the same person a second time.
   */
  private async sendInvitationEmail(
    invitation: InvitationRecord,
    email: string,
    role: OrganizationRole,
    rawToken: string,
  ): Promise<void> {
    const organization = await this.organizationStore.findOrganizationById(
      invitation.organizationId,
    );

    try {
      await this.emailSender.send(
        invitationMessage({
          to: email,
          organizationName: organization?.name ?? 'your organization',
          role: role.replace(/_/g, ' '),
          expiresInDays: Math.round(INVITATION_TTL_MS / 86_400_000),
          acceptUrl: `${this.webPublicUrl.replace(/\/$/, '')}/accept-invite?token=${encodeURIComponent(rawToken)}`,
        }),
      );
    } catch {
      // Already recorded by the audit event written above.
    }
  }

  /** Lists an organization's invitations. */
  async listInvitations(organizationId: string): Promise<readonly InvitationView[]> {
    const invitations = await this.organizationStore.listInvitations(organizationId);

    return invitations.map((invitation) => this.toInvitationView(invitation));
  }

  /** Revokes an outstanding invitation. */
  async revokeInvitation(
    organizationId: string,
    actorUserId: string,
    invitationId: string,
  ): Promise<void> {
    const revoked = await this.organizationStore.revokeInvitation(
      organizationId,
      invitationId,
      new Date(),
    );

    if (!revoked) {
      throw new AuthError('invitation_not_found', 'No such outstanding invitation.', 404);
    }

    await this.audit(organizationId, actorUserId, 'organization.invitation.revoked', 'SUCCESS', {
      organizationId,
      invitationId,
    });
  }

  /**
   * Accepts an invitation.
   *
   * Unauthenticated in the sense that it needs only a valid session: the token
   * proves the invitation, and the session says who is accepting it. There is no
   * organization guard, because at this point the caller is by definition not yet
   * a member - which is the whole reason the endpoint exists.
   */
  async acceptInvitation(
    userId: string,
    rawToken: string,
  ): Promise<{ readonly organizationId: string }> {
    const invitation = await this.organizationStore.findInvitationByTokenHash(hashToken(rawToken));

    if (!invitation) {
      throw new AuthError('invalid_or_expired_token', 'This invitation link is not valid.', 400);
    }

    const accepted = await this.organizationStore.acceptInvitation(
      invitation.tokenHash,
      userId,
      new Date(),
    );

    if (!accepted.ok) {
      throw new AuthError('invalid_or_expired_token', 'This invitation is no longer valid.', 400);
    }

    await this.audit(
      invitation.organizationId,
      userId,
      'organization.invitation.accepted',
      'SUCCESS',
      { organizationId: invitation.organizationId, invitationId: invitation.id },
    );

    return { organizationId: invitation.organizationId };
  }

  /**
   * Transfers ownership to another member.
   *
   * The previous owner becomes an `ADMIN` rather than losing their membership:
   * the person who ran the organization usually still works there, and silently
   * deleting their access would be surprising and destructive.
   */
  async transferOwnership(
    organizationId: string,
    actorUserId: string,
    newOwnerId: string,
  ): Promise<void> {
    if (actorUserId === newOwnerId) {
      throw new AuthError(
        'cannot_delegate_beyond_own_authority',
        'You already own this organization.',
        409,
      );
    }

    const result = await this.organizationStore.transferOwnership(
      organizationId,
      actorUserId,
      newOwnerId,
    );

    if (!result.ok) this.throwForMembershipFailure(result.reason);

    await this.audit(organizationId, actorUserId, 'organization.ownership.transferred', 'SUCCESS', {
      organizationId,
      previousOwnerId: actorUserId,
      newOwnerId,
    });
  }

  /** Builds the `GET /me` payload, including what the caller may do. */
  async describeCaller(
    userId: string,
    platformRole: string | null,
    memberships: readonly MembershipSummary[],
  ): Promise<MeView> {
    const user = await this.authStore.findUserById(userId);

    return {
      userId,
      email: user?.email ?? '',
      platformRole,
      termsVersion: this.termsVersion,
      termsAccepted: await this.authStore.hasAcceptedTerms(userId, this.termsVersion),
      memberships,
    };
  }

  /**
   * Every organization the user belongs to, with the organization record.
   *
   * The one intentionally unscoped read in the system, and it exists to answer
   * exactly one question - "where may this person act?" - for `GET /me`. It
   * returns memberships, never tenant data, and every read of tenant data still
   * requires an explicit organization id.
   */
  async membershipsFor(
    userId: string,
  ): Promise<readonly (MembershipRecord & { readonly organization: OrganizationRecord })[]> {
    return this.organizationStore.listMembershipsForUser(userId);
  }

  /** The roles `role` is permitted to grant. Drives the invitation form's options. */
  delegableRolesFor(role: OrganizationRole): readonly OrganizationRole[] {
    return delegableRoles(role);
  }

  private throwForMembershipFailure(reason: string): never {
    if (reason === 'last_owner') throw cannotRemoveLastOwner();
    if (reason === 'not_permitted') throw cannotDelegate();

    throw new AuthError('organization_membership_required', 'No such member.', 404);
  }

  private toInvitationView(invitation: InvitationRecord): InvitationView {
    const now = Date.now();

    return {
      id: invitation.id,
      email: invitation.email,
      role: invitation.role,
      createdAt: invitation.createdAt.toISOString(),
      expiresAt: invitation.expiresAt.toISOString(),
      acceptedAt: invitation.acceptedAt?.toISOString() ?? null,
      revokedAt: invitation.revokedAt?.toISOString() ?? null,
      outstanding:
        invitation.acceptedAt === null &&
        invitation.revokedAt === null &&
        invitation.expiresAt.getTime() > now,
    };
  }

  private async audit(
    organizationId: string,
    actorUserId: string,
    action: string,
    outcome: 'SUCCESS' | 'DENIED',
    metadata: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    assertKnownAuditAction(action);

    if (!isSafeAuditMetadata(metadata)) {
      throw new Error('Refusing to write audit metadata containing a credential-shaped key.');
    }

    await this.auditStore.record({
      organizationId,
      actorUserId,
      action,
      scope: 'ORGANIZATION',
      outcome,
      metadata,
    });
  }
}

/** Re-exported so the controller can build summaries without importing stores. */
export type { MembershipRecord };
