import { auditReason } from '@truevine/auth';
import { mutationAudit, auditDigest } from '../auth/sensitive-audit.js';
import { SECURITY_TRANSACTION, type SecurityTransaction } from '../auth/security-transaction.js';
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
  can,
  cannotDelegate,
  cannotRemoveLastOwner,
  checkEmail,
  delegableRoles,
  generateToken,
  hashToken,
  isSafeAuditMetadata,
  passwordTooWeak,
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
import { InvitationActivationConflict } from '../auth/auth.store.js';
import type { MembershipRole } from '../auth/prisma-types.js';
import { invitationMessage, type EmailSender } from '@truevine/messaging';
import { checkPassword, hashPassword } from '@truevine/auth/passwords';
import type { RateLimiter } from '../auth/rate-limiter.js';

import {
  AUDIT_STORE,
  AUTH_STORE,
  EMAIL_SENDER,
  ORGANIZATION_STORE,
  RATE_LIMITER,
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
    @Inject(SECURITY_TRANSACTION) private readonly transactions: SecurityTransaction,
    @Inject(RATE_LIMITER) private readonly rateLimiter: RateLimiter,
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
    reason?: unknown,
  ): Promise<OrganizationView> {
    return this.transactions
      .run(async (stores) => {
        const scoped = new OrganizationsService(
          stores.organizations,
          stores.auth,
          stores.audit,
          this.emailSender,
          this.webPublicUrl,
          this.termsVersion,
          this.transactions,
          this.rateLimiter,
        );
        await stores.lockOrganization(organizationId);
        const freshActor = await stores.organizations.findMembership(organizationId, actorUserId);
        const freshOrg = await stores.organizations.findOrganizationById(organizationId);
        if (
          !freshActor ||
          !freshOrg ||
          freshOrg.suspendedAt ||
          !can(freshActor.role, 'organization:update')
        )
          throw cannotDelegate();

        const trimmed = name.trim();

        if (trimmed.length === 0 || trimmed.length > 200) {
          throw new AuthError(
            'invalid_email',
            'Organization name must be 1 to 200 characters.',
            400,
          );
        }

        const audit = auditReason(reason, 'organization_profile_update');
        const beforeNameDigest = auditDigest(freshOrg.name);
        const updated = await stores.organizations.updateName(organizationId, trimmed);

        await scoped.audit(organizationId, actorUserId, 'organization.profile_updated', 'SUCCESS', {
          organizationId,
          ...mutationAudit({
            targetType: 'organization',
            targetId: organizationId,
            before: { nameDigest: beforeNameDigest },
            change: { fields: ['name'] },
            after: { nameDigest: auditDigest(updated.name) },
            ...audit,
          }),
        });

        return updated;
      })
      .catch(async (error) => {
        if (error instanceof AuthError)
          await this.audit(organizationId, actorUserId, 'authorization.denied', 'DENIED', {
            reason: error.code,
            attemptedAction: 'organization.profile_updated',
            claimedTarget: { type: 'organization', id: organizationId },
          }).catch(() => process.stderr.write('[audit] Denial recording unavailable.\n'));
        throw error;
      });
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
    reason?: unknown,
  ): Promise<void> {
    return this.transactions
      .run(async (stores) => {
        const scoped = new OrganizationsService(
          stores.organizations,
          stores.auth,
          stores.audit,
          this.emailSender,
          this.webPublicUrl,
          this.termsVersion,
          this.transactions,
          this.rateLimiter,
        );
        await stores.lockOrganization(organizationId);
        const freshActor = await stores.organizations.findMembership(organizationId, actor.userId);
        const freshOrg = await stores.organizations.findOrganizationById(organizationId);
        if (
          !freshActor ||
          !freshOrg ||
          freshOrg.suspendedAt ||
          !can(freshActor.role, 'member:update')
        )
          throw cannotDelegate();
        if (actor.role !== freshActor.role) throw cannotDelegate();

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

        const before = await stores.organizations.findMembership(organizationId, targetUserId);
        if (before && actor.role !== 'OWNER' && !canDelegate(actor.role, before.role))
          throw cannotDelegate();
        const priorRole = before?.role ?? null;
        const audit = auditReason(reason, 'membership_role_change');
        const result = await stores.organizations.changeMembershipRole(
          organizationId,
          targetUserId,
          nextRole as MembershipRole,
        );

        if (!result.ok) this.throwForMembershipFailure(result.reason);

        await scoped.audit(
          organizationId,
          actor.userId,
          'organization.member.role_changed',
          'SUCCESS',
          {
            organizationId,
            targetUserId,
            role: nextRole,
            ...mutationAudit({
              targetType: 'membership',
              targetId: targetUserId,
              before: priorRole === null ? null : { role: priorRole },
              change: { role: nextRole },
              after: { role: nextRole },
              ...audit,
            }),
          },
        );
      })
      .catch(async (error) => {
        if (error instanceof AuthError)
          await this.audit(organizationId, actor.userId, 'authorization.denied', 'DENIED', {
            reason: error.code,
            attemptedAction: 'organization.member.role_changed',
            claimedTarget: { type: 'membership', id: targetUserId },
          }).catch(() => process.stderr.write('[audit] Denial recording unavailable.\n'));
        throw error;
      });
  }

  /** Removes a member, refusing to remove the last owner. */
  async removeMember(
    organizationId: string,
    actor: { readonly userId: string; readonly role: OrganizationRole },
    targetUserId: string,
    reason?: unknown,
  ): Promise<void> {
    return this.transactions
      .run(async (stores) => {
        const scoped = new OrganizationsService(
          stores.organizations,
          stores.auth,
          stores.audit,
          this.emailSender,
          this.webPublicUrl,
          this.termsVersion,
          this.transactions,
          this.rateLimiter,
        );
        await stores.lockOrganization(organizationId);
        const freshActor = await stores.organizations.findMembership(organizationId, actor.userId);
        const freshOrg = await stores.organizations.findOrganizationById(organizationId);
        if (
          !freshActor ||
          !freshOrg ||
          freshOrg.suspendedAt ||
          !can(freshActor.role, 'member:remove')
        )
          throw cannotDelegate();
        if (actor.role !== freshActor.role) throw cannotDelegate();

        if (targetUserId === actor.userId) {
          throw new AuthError(
            'cannot_delegate_beyond_own_authority',
            'You cannot remove yourself.',
            409,
          );
        }

        // Removal follows the same ladder as granting a role: the target's
        // authority must sit strictly below the actor's, so an ADMIN may remove
        // a campaign manager or a viewer but never a peer ADMIN, an OWNER or a
        // BILLING - exactly the roles `canDelegate` already refuses to hand
        // out. The registry grants ADMIN `member:remove`; this is the check
        // that keeps that permission inside the delegation ladder rather than
        // making it a way to unseat an equal or a superior. An OWNER keeps an
        // explicit exception, because ownership is not a delegable role and
        // the store's last-owner rule is what protects it here.
        const target = await stores.organizations.findMembership(organizationId, targetUserId);

        if (!target) this.throwForMembershipFailure('not_found');
        if (actor.role !== 'OWNER' && !canDelegate(actor.role, target.role)) {
          throw cannotDelegate();
        }

        const audit = auditReason(reason, 'membership_removal');
        const result = await stores.organizations.removeMembership(organizationId, targetUserId);

        if (!result.ok) this.throwForMembershipFailure(result.reason);

        await scoped.audit(organizationId, actor.userId, 'organization.member.removed', 'SUCCESS', {
          organizationId,
          targetUserId,
          ...mutationAudit({
            targetType: 'membership',
            targetId: targetUserId,
            before: { role: target.role },
            change: { removed: true },
            after: null,
            ...audit,
          }),
        });
      })
      .catch(async (error) => {
        if (error instanceof AuthError)
          await this.audit(organizationId, actor.userId, 'authorization.denied', 'DENIED', {
            reason: error.code,
            attemptedAction: 'organization.member.removed',
            claimedTarget: { type: 'membership', id: targetUserId },
          }).catch(() => process.stderr.write('[audit] Denial recording unavailable.\n'));
        throw error;
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
    reason?: unknown,
  ): Promise<InvitationView> {
    const issued = await this.transactions
      .run(async (stores) => {
        const scoped = new OrganizationsService(
          stores.organizations,
          stores.auth,
          stores.audit,
          this.emailSender,
          this.webPublicUrl,
          this.termsVersion,
          this.transactions,
          this.rateLimiter,
        );
        await stores.lockOrganization(organizationId);
        const freshActor = await stores.organizations.findMembership(organizationId, actor.userId);
        const freshOrg = await stores.organizations.findOrganizationById(organizationId);
        if (
          !freshActor ||
          !freshOrg ||
          freshOrg.suspendedAt ||
          !can(freshActor.role, 'member:invite')
        )
          throw cannotDelegate();
        if (actor.role !== freshActor.role) throw cannotDelegate();

        if (role === 'OWNER') throw cannotDelegate();
        if (!canDelegate(actor.role, role)) throw cannotDelegate();

        const normalized = checkEmail(email);

        if (!normalized.ok) {
          throw new AuthError('invalid_email', 'That email address is not valid.', 400);
        }

        const outstanding = await stores.organizations.findOutstandingInvitationByEmail(
          organizationId,
          normalized.value,
        );

        if (outstanding.some((invitation) => invitation.organizationId === organizationId)) {
          throw new AuthError(
            'email_already_registered',
            'An invitation is already outstanding.',
            409,
          );
        }

        const audit = auditReason(reason, 'membership_invitation');
        const raw = generateToken();
        const created = await stores.organizations.createInvitation({
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

        await scoped.audit(organizationId, actor.userId, 'organization.member.invited', 'SUCCESS', {
          organizationId,
          emailDigest: auditDigest(normalized.value),
          role,
          ...mutationAudit({
            targetType: 'invitation',
            targetId: created.id,
            before: null,
            change: { role },
            after: { role, accepted: false, revoked: false },
            ...audit,
          }),
        });

        return { created, raw, email: normalized.value };
      })
      .catch(async (error) => {
        if (error instanceof AuthError)
          await this.audit(organizationId, actor.userId, 'authorization.denied', 'DENIED', {
            reason: error.code,
            attemptedAction: 'organization.member.invited',
            claimedTarget: { type: 'organization', id: organizationId },
          }).catch(() => process.stderr.write('[audit] Denial recording unavailable.\n'));
        throw error;
      });
    await this.sendInvitationEmail(issued.created, issued.email, role, issued.raw);
    return this.toInvitationView(issued.created);
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
    try {
      const organization = await this.organizationStore.findOrganizationById(
        invitation.organizationId,
      );
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
      // Creation is already committed; do not report it as absent.
      process.stderr.write('[email] Invitation delivery failed; invitation remains recorded.\n');
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
    reason?: unknown,
  ): Promise<void> {
    return this.transactions
      .run(async (stores) => {
        const scoped = new OrganizationsService(
          stores.organizations,
          stores.auth,
          stores.audit,
          this.emailSender,
          this.webPublicUrl,
          this.termsVersion,
          this.transactions,
          this.rateLimiter,
        );
        await stores.lockOrganization(organizationId);
        const freshActor = await stores.organizations.findMembership(organizationId, actorUserId);
        const freshOrg = await stores.organizations.findOrganizationById(organizationId);
        if (
          !freshActor ||
          !freshOrg ||
          freshOrg.suspendedAt ||
          !can(freshActor.role, 'invitation:revoke')
        )
          throw cannotDelegate();

        const before = await stores.organizations.findInvitationState(organizationId, invitationId);
        const priorInvitation = before
          ? {
              role: before.role,
              revoked: before.revokedAt !== null,
              accepted: before.acceptedAt !== null,
            }
          : null;
        const audit = auditReason(reason, 'invitation_revocation');
        const revoked = await stores.organizations.revokeInvitation(
          organizationId,
          invitationId,
          new Date(),
        );

        if (!revoked) {
          throw new AuthError('invitation_not_found', 'No such outstanding invitation.', 404);
        }

        await scoped.audit(
          organizationId,
          actorUserId,
          'organization.invitation.revoked',
          'SUCCESS',
          {
            organizationId,
            invitationId,
            ...mutationAudit({
              targetType: 'invitation',
              targetId: invitationId,
              before: priorInvitation,
              change: { revoked: true },
              after: { role: before?.role ?? null, revoked: true, accepted: false },
              ...audit,
            }),
          },
        );
      })
      .catch(async (error) => {
        if (error instanceof AuthError)
          await this.audit(organizationId, actorUserId, 'authorization.denied', 'DENIED', {
            reason: error.code,
            attemptedAction: 'organization.invitation.revoked',
            claimedTarget: { type: 'invitation', id: invitationId },
          }).catch(() => process.stderr.write('[audit] Denial recording unavailable.\n'));
        throw error;
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
    const result = await this.transactions.run(async (stores) => {
      const scoped = new OrganizationsService(
        stores.organizations,
        stores.auth,
        stores.audit,
        this.emailSender,
        this.webPublicUrl,
        this.termsVersion,
        this.transactions,
        this.rateLimiter,
      );

      const invitation = await stores.organizations.findInvitationByTokenHash(hashToken(rawToken));

      if (!invitation) {
        throw new AuthError('invalid_or_expired_token', 'This invitation link is not valid.', 400);
      }

      await stores.lockOrganization(invitation.organizationId);
      const identity = await stores.auth.findUserById(userId);
      if (
        !identity ||
        identity.status !== 'ACTIVE' ||
        identity.email.toLowerCase() !== invitation.email.toLowerCase()
      ) {
        await stores.audit.record({
          organizationId: invitation.organizationId,
          actorUserId: userId,
          action: 'authorization.denied',
          scope: 'ORGANIZATION',
          outcome: 'DENIED',
          metadata: {
            reason: 'invitation_identity_mismatch',
            ...mutationAudit({
              targetType: 'invitation',
              targetId: invitation.id,
              before: null,
              change: { attemptedAction: 'organization.invitation.accepted' },
              after: null,
              reasonCode: 'invitation_identity_mismatch',
            }),
          },
        });
        return { organizationId: '' };
      }
      const beforeMembership = await stores.organizations.findMembership(
        invitation.organizationId,
        userId,
      );
      const accepted = await stores.organizations.acceptInvitation(
        invitation.tokenHash,
        userId,
        new Date(),
      );

      if (!accepted.ok) {
        await stores.audit.record({
          organizationId: invitation.organizationId,
          actorUserId: userId,
          action: 'authorization.denied',
          scope: 'ORGANIZATION',
          outcome: 'DENIED',
          metadata: {
            reason: 'invitation_not_available',
            ...mutationAudit({
              targetType: 'invitation',
              targetId: invitation.id,
              before: null,
              change: { attemptedAction: 'organization.invitation.accepted' },
              after: null,
              reasonCode: 'invitation_not_available',
            }),
          },
        });
        return { organizationId: '' };
      }

      await scoped.audit(
        invitation.organizationId,
        userId,
        'organization.invitation.accepted',
        'SUCCESS',
        {
          organizationId: invitation.organizationId,
          invitationId: invitation.id,
          ...mutationAudit({
            targetType: 'membership',
            targetId: userId,
            before: beforeMembership ? { role: beforeMembership.role } : null,
            change: { invitationId: invitation.id, accepted: true },
            after: { role: beforeMembership?.role ?? invitation.role },
            reasonCode: 'invitation_acceptance',
          }),
        },
      );

      return { organizationId: invitation.organizationId };
    });
    if (!result.organizationId)
      throw new AuthError(
        'invalid_or_expired_token',
        'This invitation is not valid for this account.',
        400,
      );
    return result;
  }

  /** Creates a new invited identity and membership using the invitation token as proof. */
  async activateInvitation(
    rawToken: string,
    password: string,
    ipPrefix: string | null,
  ): Promise<{ readonly organizationId: string }> {
    const windowMs = 15 * 60 * 1_000;
    const limit = await this.rateLimiter.consume(
      `invitation-activation:${ipPrefix ?? 'unknown'}`,
      5,
      windowMs,
    );
    if (!limit.allowed)
      throw new AuthError(
        'invalid_or_expired_token',
        'Too many activation attempts. Try again later.',
        429,
      );

    const passwordProblem = checkPassword(password);
    if (passwordProblem)
      throw passwordTooWeak(
        passwordProblem === 'too_short'
          ? 'Password must be at least 12 characters.'
          : passwordProblem === 'too_long'
            ? 'Password must be no more than 200 characters.'
            : 'A password is required.',
      );

    const tokenHash = hashToken(rawToken);
    const passwordHash = await hashPassword(password);
    let result: Awaited<ReturnType<OrganizationStore['activateInvitation']>>;
    try {
      result = await this.transactions.run(async (stores) => {
        const activation = await stores.organizations.activateInvitation(
          tokenHash,
          { id: randomUUID(), passwordHash },
          new Date(),
        );
        if (!activation.ok) return activation;

        const scoped = new OrganizationsService(
          stores.organizations,
          stores.auth,
          stores.audit,
          this.emailSender,
          this.webPublicUrl,
          this.termsVersion,
          this.transactions,
          this.rateLimiter,
        );
        await scoped.audit(
          activation.organizationId,
          activation.userId,
          'organization.invitation.accepted',
          'SUCCESS',
          {
            organizationId: activation.organizationId,
            ...mutationAudit({
              targetType: 'membership',
              targetId: activation.userId,
              before: null,
              change: { invitationAccepted: true },
              after: { membershipCreated: true },
              reasonCode: 'invitation_account_activation',
            }),
          },
        );
        return activation;
      });
    } catch (error) {
      if (error instanceof InvitationActivationConflict)
        throw new AuthError('invalid_or_expired_token', 'This invitation link is not valid.', 400);
      throw error;
    }

    if (!result.ok) {
      throw new AuthError(
        result.reason === 'account_exists'
          ? 'email_already_registered'
          : 'invalid_or_expired_token',
        result.reason === 'account_exists'
          ? 'An account already exists for this invitation. Sign in to accept it.'
          : 'This invitation link is not valid.',
        result.reason === 'account_exists' ? 409 : 400,
      );
    }
    return { organizationId: result.organizationId };
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
    reason?: unknown,
  ): Promise<void> {
    return this.transactions
      .run(async (stores) => {
        const scoped = new OrganizationsService(
          stores.organizations,
          stores.auth,
          stores.audit,
          this.emailSender,
          this.webPublicUrl,
          this.termsVersion,
          this.transactions,
          this.rateLimiter,
        );
        await stores.lockOrganization(organizationId);
        const freshActor = await stores.organizations.findMembership(organizationId, actorUserId);
        const freshOrg = await stores.organizations.findOrganizationById(organizationId);
        if (
          !freshActor ||
          !freshOrg ||
          freshOrg.suspendedAt ||
          !can(freshActor.role, 'ownership:transfer')
        )
          throw new AuthError('organization_membership_required', 'No such member.', 404);

        if (actorUserId === newOwnerId) {
          throw new AuthError(
            'cannot_delegate_beyond_own_authority',
            'You already own this organization.',
            409,
          );
        }

        const beforeOwner = await stores.organizations.findMembership(organizationId, newOwnerId);
        const priorOwnerRole = beforeOwner?.role ?? null;
        const audit = auditReason(reason, 'ownership_transfer');
        const result = await stores.organizations.transferOwnership(
          organizationId,
          actorUserId,
          newOwnerId,
        );

        if (!result.ok) this.throwForMembershipFailure(result.reason);

        await scoped.audit(
          organizationId,
          actorUserId,
          'organization.ownership.transferred',
          'SUCCESS',
          {
            organizationId,
            previousOwnerId: actorUserId,
            newOwnerId,
            ...mutationAudit({
              targetType: 'organization',
              targetId: organizationId,
              before: {
                ownerId: actorUserId,
                previousOwnerRole: 'OWNER',
                newOwnerRole: priorOwnerRole,
              },
              change: { ownerId: newOwnerId },
              after: { ownerId: newOwnerId, previousOwnerRole: 'ADMIN', newOwnerRole: 'OWNER' },
              ...audit,
            }),
          },
        );
      })
      .catch(async (error) => {
        if (error instanceof AuthError)
          await this.audit(organizationId, actorUserId, 'authorization.denied', 'DENIED', {
            reason: error.code,
            attemptedAction: 'organization.ownership.transferred',
            claimedTarget: { type: 'organization', id: organizationId },
          }).catch(() => process.stderr.write('[audit] Denial recording unavailable.\n'));
        throw error;
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

    if (outcome === 'DENIED')
      metadata = {
        ...metadata,
        ...mutationAudit({
          targetType: 'organization',
          targetId: organizationId,
          before: null,
          change: {
            attemptedAction: metadata['attemptedAction'] ?? action,
            claimedTarget: metadata['claimedTarget'] ?? null,
          },
          after: null,
          reasonCode:
            typeof metadata['reason'] === 'string' ? metadata['reason'] : 'sensitive_action_denied',
        }),
      };
    await this.auditStore.record({
      organizationId,
      actorUserId,
      action,
      scope: 'ORGANIZATION',
      outcome,
      targetType: (metadata['target'] as { type?: string } | undefined)?.type,
      targetId: (metadata['target'] as { id?: string } | undefined)?.id,
      metadata,
    });
  }
}

/** Re-exported so the controller can build summaries without importing stores. */
export type { MembershipRecord };
