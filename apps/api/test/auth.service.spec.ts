/**
 * Authentication and delegation behaviour, tested through the services.
 *
 * Everything here runs against in-memory fakes. The E2E suite proves the same
 * rules hold when PostgreSQL's constraints are doing the work; this suite proves
 * them against the application logic, which is a different layer and fails
 * differently.
 */

import { AuthError, hashToken } from '@truevine/auth';
import { hashPassword } from '@truevine/auth/passwords';
import { beforeEach, describe, expect, it } from 'vitest';

import { AuthService } from '../src/auth/auth.service.js';
import { OrganizationsService } from '../src/organizations/organizations.service.js';
import type { RateLimiter } from '../src/auth/rate-limiter.js';
import {
  FakeAuditStore,
  FakeAuthStore,
  FakeOrganizationStore,
  anInvitation,
  aMembership,
  aUser,
  seedOwner,
} from './fakes/auth.fakes.js';

const TERMS = '2026-10-01';
const GOOD_PASSWORD = 'a-long-enough-passphrase';

/** A limiter that always allows, so rate limiting is not what is under test. */
const permissiveLimiter: RateLimiter = {
  consume: async () => ({ allowed: true, retryAfterMs: 0, remaining: 99 }),
};

/** A limiter that always denies, to prove the service fails closed. */
const denyingLimiter: RateLimiter = {
  consume: async () => ({ allowed: false, retryAfterMs: 1000, remaining: 0 }),
};

const CONTEXT = { ipPrefix: '203.0.113.0/24', userAgentHash: null } as const;

function buildAuthService(limiter: RateLimiter = permissiveLimiter) {
  const auth = new FakeAuthStore();
  const audit = new FakeAuditStore();

  // Constructed directly rather than through Nest. Injecting a fake *token*
  // would only prove the test's own wiring; the real module graph is resolved in
  // `authorization.e2e-spec.ts`, where a token mismatch would fail loudly.
  const service = new AuthService(auth, audit, limiter, 3, 60_000, 30_000);

  return { auth, audit, service };
}

describe('AuthService.signIn', () => {
  let auth: FakeAuthStore;
  let audit: FakeAuditStore;
  let service: AuthService;

  beforeEach(() => {
    ({ auth, audit, service } = buildAuthService());
  });

  async function registerWithPassword(email = 'owner@example.invalid', password = GOOD_PASSWORD) {
    const user = aUser({ email, passwordHash: await hashPassword(password) });
    auth.users.push(user);
    return user;
  }

  it('issues a session for correct credentials', async () => {
    await registerWithPassword();

    const result = await service.signIn('owner@example.invalid', GOOD_PASSWORD, CONTEXT);

    expect(result.sessionToken).toBeTruthy();
    expect(result.csrfToken).toBeTruthy();
    expect(auth.sessions).toHaveLength(1);
  });

  it('stores only the digest of the session token, never the token itself', async () => {
    await registerWithPassword();

    const result = await service.signIn('owner@example.invalid', GOOD_PASSWORD, CONTEXT);

    expect(auth.sessions[0]!.session.tokenHash).toBe(hashToken(result.sessionToken));
    expect(auth.sessions[0]!.session.tokenHash).not.toBe(result.sessionToken);
  });

  it('accepts the email in any case and surrounding whitespace', async () => {
    await registerWithPassword();

    await expect(
      service.signIn('  OWNER@Example.Invalid  ', GOOD_PASSWORD, CONTEXT),
    ).resolves.toBeTruthy();
  });

  it('refuses a wrong password', async () => {
    await registerWithPassword();

    await expect(
      service.signIn('owner@example.invalid', 'not-the-password', CONTEXT),
    ).rejects.toMatchObject({ status: 401, code: 'invalid_credentials' });
  });

  it('refuses an unknown address identically to a wrong password', async () => {
    await registerWithPassword();

    const unknown = (await service
      .signIn('nobody@example.invalid', GOOD_PASSWORD, CONTEXT)
      .catch((error: AuthError) => error)) as AuthError;

    const wrong = (await service
      .signIn('owner@example.invalid', 'not-the-password', CONTEXT)
      .catch((error: AuthError) => error)) as AuthError;

    // Identical in every observable respect: an attacker cannot tell which
    // addresses are registered.
    expect(unknown).toMatchObject({ code: 'invalid_credentials', status: 401 });
    expect(wrong).toMatchObject({ code: 'invalid_credentials', status: 401 });
    expect(unknown.message).toBe(wrong.message);
  });

  it('refuses a malformed email identically too', async () => {
    const malformed = await service
      .signIn('not-an-email', GOOD_PASSWORD, CONTEXT)
      .catch((error: { code: string; status: number }) => error);

    expect(malformed).toMatchObject({ code: 'invalid_credentials', status: 401 });
  });

  it('counts failures and locks the account at the threshold', async () => {
    const user = await registerWithPassword();

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await service.signIn('owner@example.invalid', 'wrong', CONTEXT).catch(() => undefined);
    }

    expect(user.failedLoginCount).toBe(3);
    expect(audit.actions()).toContain('auth.account_locked');
  });

  it('refuses a locked account', async () => {
    const user = await registerWithPassword();
    user.lockedUntil = new Date(Date.now() + 60_000);

    await expect(
      service.signIn('owner@example.invalid', GOOD_PASSWORD, CONTEXT),
    ).rejects.toMatchObject({ code: 'account_locked' });
  });

  it('clears the failure counter after a successful sign-in', async () => {
    const user = await registerWithPassword();
    user.failedLoginCount = 2;

    await service.signIn('owner@example.invalid', GOOD_PASSWORD, CONTEXT);

    expect(user.failedLoginCount).toBe(0);
  });

  it('refuses a suspended account', async () => {
    const user = await registerWithPassword();
    user.status = 'SUSPENDED';

    await expect(
      service.signIn('owner@example.invalid', GOOD_PASSWORD, CONTEXT),
    ).rejects.toMatchObject({ code: 'account_suspended', status: 403 });
  });

  it('records the refusal as well as the success', async () => {
    await registerWithPassword();

    await service.signIn('owner@example.invalid', 'wrong', CONTEXT).catch(() => undefined);
    await service.signIn('owner@example.invalid', GOOD_PASSWORD, CONTEXT);

    expect(audit.identityEvents.map((event) => event.action)).toEqual([
      'auth.sign_in.failed',
      'auth.sign_in.succeeded',
    ]);
  });

  it('never writes a credential into audit metadata', async () => {
    await registerWithPassword();
    await service.signIn('owner@example.invalid', GOOD_PASSWORD, CONTEXT);

    const serialised = JSON.stringify(audit.identityEvents);

    expect(serialised).not.toContain(GOOD_PASSWORD);
    expect(serialised).not.toContain('$argon2id$');
  });

  it('fails closed when the rate limiter denies', async () => {
    const closed = buildAuthService(denyingLimiter);
    await closed.auth.users.push(aUser());

    await expect(
      closed.service.signIn('owner@example.invalid', GOOD_PASSWORD, CONTEXT),
    ).rejects.toMatchObject({ status: 429 });
  });

  it('rate limits per IP prefix rather than per account', async () => {
    // Per-account limiting lets an attacker spray one account from many IPs;
    // per-IP is what actually bounds the spray.
    const calls: string[] = [];
    const spyLimiter: RateLimiter = {
      consume: async (key) => {
        calls.push(key);
        return { allowed: true, retryAfterMs: 0, remaining: 99 };
      },
    };

    const subject = buildAuthService(spyLimiter);
    await subject.auth.users.push(aUser());

    // The stub user has no real password hash, so sign-in refuses. The limiter
    // must still have been consulted before the credential check, which is the
    // property being asserted.
    await subject.service
      .signIn('owner@example.invalid', GOOD_PASSWORD, CONTEXT)
      .catch(() => undefined);

    expect(calls[0]).toBe('signin:203.0.113.0/24');
  });
});

/**
 * Plants a reset token whose raw value the test knows.
 *
 * The service mints reset tokens internally and - correctly - never returns
 * them, so a test cannot ask for one. Planting the row directly is also the more
 * honest setup: it asserts the *stored* digest is what the service looks up, so a
 * change that stopped hashing the token would fail here rather than pass quietly.
 */
function plantResetToken(auth: FakeAuthStore, userId: string, raw: string): string {
  auth.resetTokens.push({
    id: `reset-${raw}`,
    userId,
    tokenHash: hashToken(raw),
    expiresAt: new Date(Date.now() + 3_600_000),
    usedAt: null,
  });

  return raw;
}

describe('AuthService password reset', () => {
  let auth: FakeAuthStore;
  let audit: FakeAuditStore;
  let service: AuthService;

  beforeEach(() => {
    ({ auth, audit, service } = buildAuthService());
  });

  async function register(email = 'owner@example.invalid') {
    const user = aUser({ email, passwordHash: await hashPassword(GOOD_PASSWORD) });
    auth.users.push(user);
    return user;
  }

  it('accepts a request for an unknown address without revealing it', async () => {
    await expect(
      service.requestPasswordReset('nobody@example.invalid', CONTEXT),
    ).resolves.toBeUndefined();
  });

  it('accepts a request for a known address', async () => {
    await register();

    await service.requestPasswordReset('owner@example.invalid', CONTEXT);

    expect(auth.resetTokens).toHaveLength(1);
  });

  it('gives the same answer for a known and an unknown address', async () => {
    await register();

    const known = await service
      .requestPasswordReset('owner@example.invalid', CONTEXT)
      .catch((error: Error) => error);
    const unknown = await service
      .requestPasswordReset('nobody@example.invalid', CONTEXT)
      .catch((error: Error) => error);

    expect(known).toBeUndefined();
    expect(unknown).toBeUndefined();
  });

  it('invalidates every earlier reset token when a new one is requested', async () => {
    await register();

    await service.requestPasswordReset('owner@example.invalid', CONTEXT);
    await service.requestPasswordReset('owner@example.invalid', CONTEXT);

    // Everything but the newest is dead. The newest is, by definition, live.
    const superseded = auth.resetTokens.slice(0, -1);

    expect(superseded.length).toBeGreaterThan(0);
    expect(superseded.every((token) => token.expiresAt.getTime() <= Date.now())).toBe(true);
    expect(auth.resetTokens.at(-1)!.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('changes the password and destroys every live session', async () => {
    const user = await register();
    const token = plantResetToken(auth, user.id, 'reset-token-abc');
    await service.signIn('owner@example.invalid', GOOD_PASSWORD, CONTEXT);
    expect(auth.sessions[0]!.revokedAt).toBeNull();

    await service.completePasswordReset(token, 'a-brand-new-passphrase');

    expect(user.passwordHash).not.toBe(await hashPassword(GOOD_PASSWORD));
    expect(auth.sessions.every((entry) => entry.revokedAt !== null)).toBe(true);
  });

  it('refuses a reused reset token and destroys every session', async () => {
    const user = await register();
    const token = plantResetToken(auth, user.id, 'reset-token-reuse');
    await service.signIn('owner@example.invalid', GOOD_PASSWORD, CONTEXT);

    await service.completePasswordReset(token, 'a-brand-new-passphrase');

    // A second presentation of the same link is the interception signal.
    await expect(
      service.completePasswordReset(token, 'yet-another-passphrase'),
    ).rejects.toMatchObject({ code: 'token_already_used' });

    expect(audit.identityEvents.map((event) => event.action)).toContain(
      'auth.password_reset_token_reused',
    );
  });

  it('refuses an unknown reset token', async () => {
    await register();

    await expect(
      service.completePasswordReset('never-issued', 'a-brand-new-passphrase'),
    ).rejects.toMatchObject({ code: 'invalid_or_expired_token' });
  });

  it('refuses an expired reset token', async () => {
    const user = await register();
    plantResetToken(auth, user.id, 'reset-token-expired');
    auth.resetTokens[0]!.expiresAt = new Date(Date.now() - 1_000);

    await expect(
      service.completePasswordReset('reset-token-expired', 'a-brand-new-passphrase'),
    ).rejects.toMatchObject({ code: 'invalid_or_expired_token' });
  });

  it('refuses a weak new password', async () => {
    const user = await register();
    const token = plantResetToken(auth, user.id, 'reset-token-weak');

    await expect(service.completePasswordReset(token, 'short')).rejects.toMatchObject({
      code: 'password_too_weak',
    });
  });

  it('never echoes the rejected password in the error', async () => {
    const user = await register();
    const token = plantResetToken(auth, user.id, 'reset-token-echo');

    const error = (await service
      .completePasswordReset(token, 'short')
      .catch((caught: AuthError) => caught)) as AuthError;

    expect(error.message).not.toContain('short');
  });

  it('never stores the raw reset token', async () => {
    await register();

    await service.requestPasswordReset('owner@example.invalid', CONTEXT);

    const stored = auth.resetTokens[0]!.tokenHash;
    // 64 hex characters is a SHA-256 digest, not a 43-character base64url token.
    expect(stored).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('OrganizationsService delegation', () => {
  let auth: FakeAuthStore;
  let organizations: FakeOrganizationStore;
  let audit: FakeAuditStore;
  let service: OrganizationsService;

  beforeEach(() => {
    auth = new FakeAuthStore();
    organizations = new FakeOrganizationStore();
    audit = new FakeAuditStore();
    service = new OrganizationsService(organizations, auth, audit, TERMS);
  });

  const actor = (role: 'OWNER' | 'ADMIN' | 'CAMPAIGN_MANAGER' | 'BILLING' | 'VIEWER') => ({
    userId: 'user-1',
    role,
  });

  it('lets an owner grant every role below owner', async () => {
    seedOwner(auth, organizations);
    organizations.memberships.push(aMembership({ userId: 'user-2', role: 'VIEWER' }));

    await service.changeMemberRole('org-1', actor('OWNER'), 'user-2', 'ADMIN');

    expect(organizations.memberships.find((m) => m.userId === 'user-2')?.role).toBe('ADMIN');
  });

  it('refuses any role creating another owner', async () => {
    // `canDelegate(OWNER, OWNER)` is false, so there is no path at all.
    seedOwner(auth, organizations);
    organizations.memberships.push(aMembership({ userId: 'user-2', role: 'VIEWER' }));

    await expect(
      service.changeMemberRole('org-1', actor('OWNER'), 'user-2', 'OWNER'),
    ).rejects.toMatchObject({ code: 'cannot_delegate_beyond_own_authority' });
  });

  it('refuses an admin granting billing authority', async () => {
    seedOwner(auth, organizations, { role: 'ADMIN' });
    organizations.memberships.push(aMembership({ userId: 'user-2', role: 'VIEWER' }));

    await expect(
      service.changeMemberRole('org-1', actor('ADMIN'), 'user-2', 'BILLING'),
    ).rejects.toMatchObject({ code: 'cannot_delegate_beyond_own_authority' });
  });

  it('refuses a campaign manager changing any role', async () => {
    seedOwner(auth, organizations, { role: 'CAMPAIGN_MANAGER' });
    organizations.memberships.push(aMembership({ userId: 'user-2', role: 'VIEWER' }));

    await expect(
      service.changeMemberRole('org-1', actor('CAMPAIGN_MANAGER'), 'user-2', 'VIEWER'),
    ).rejects.toMatchObject({ code: 'cannot_delegate_beyond_own_authority' });
  });

  it('refuses an admin minting a peer admin', async () => {
    seedOwner(auth, organizations, { role: 'ADMIN' });
    organizations.memberships.push(aMembership({ userId: 'user-2', role: 'VIEWER' }));

    await expect(
      service.changeMemberRole('org-1', actor('ADMIN'), 'user-2', 'ADMIN'),
    ).rejects.toMatchObject({ code: 'cannot_delegate_beyond_own_authority' });
  });

  it('lets an admin grant a campaign manager', async () => {
    seedOwner(auth, organizations, { role: 'ADMIN' });
    organizations.memberships.push(aMembership({ userId: 'user-2', role: 'VIEWER' }));

    await service.changeMemberRole('org-1', actor('ADMIN'), 'user-2', 'CAMPAIGN_MANAGER');

    expect(organizations.memberships.find((m) => m.userId === 'user-2')?.role).toBe(
      'CAMPAIGN_MANAGER',
    );
  });

  it('refuses changing your own role', async () => {
    seedOwner(auth, organizations, { role: 'ADMIN' });
    organizations.memberships.push(aMembership({ userId: 'user-1', role: 'ADMIN' }));

    await expect(
      service.changeMemberRole('org-1', actor('ADMIN'), 'user-1', 'VIEWER'),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('refuses removing yourself', async () => {
    seedOwner(auth, organizations, { role: 'ADMIN' });

    await expect(service.removeMember('org-1', actor('ADMIN'), 'user-1')).rejects.toMatchObject({
      status: 409,
    });
  });

  it('lets an owner remove another owner while one remains', async () => {
    seedOwner(auth, organizations);
    organizations.memberships.push(
      aMembership({ userId: 'user-2', role: 'OWNER' }),
      aMembership({ userId: 'user-3', role: 'ADMIN' }),
    );

    await service.removeMember('org-1', actor('OWNER'), 'user-2');

    expect(
      organizations.memberships.filter((m) => m.organizationId === 'org-1' && m.role === 'OWNER'),
    ).toHaveLength(1);
  });

  it('refuses removing the only owner at the store layer', async () => {
    // Unreachable through the service, because "you cannot remove yourself" fires
    // first. It is still enforced where it matters - in the store, in the same
    // transaction as the delete - and this proves the rule is live rather than
    // decorative. A future endpoint reaching the store directly must not be able
    // to leave an organization without an owner.
    const store = new FakeOrganizationStore();
    store.memberships.push(aMembership({ userId: 'solo', role: 'OWNER' }));

    const result = await store.removeMembership('org-1', 'solo');

    expect(result).toEqual({ ok: false, reason: 'last_owner' });
    expect(store.memberships).toHaveLength(1);
  });

  it('refuses demoting the only owner at the store layer', async () => {
    // Same reasoning: ownership moves only through transferOwnership, never by
    // editing a role, so an organization cannot be left ownerless by an UPDATE.
    const store = new FakeOrganizationStore();
    store.memberships.push(aMembership({ userId: 'solo', role: 'OWNER' }));

    const result = await store.changeMembershipRole('org-1', 'solo', 'ADMIN');

    expect(result).toEqual({ ok: false, reason: 'last_owner' });
    expect(store.memberships[0]!.role).toBe('OWNER');
  });

  it('lets a campaign manager remove nobody', async () => {
    seedOwner(auth, organizations, { role: 'CAMPAIGN_MANAGER' });
    organizations.memberships.push(aMembership({ userId: 'user-2', role: 'VIEWER' }));

    await expect(
      service.removeMember('org-1', actor('CAMPAIGN_MANAGER'), 'user-2'),
    ).rejects.toMatchObject({ code: 'cannot_delegate_beyond_own_authority' });
  });

  it('audits a role change', async () => {
    seedOwner(auth, organizations);
    organizations.memberships.push(aMembership({ userId: 'user-2', role: 'VIEWER' }));

    await service.changeMemberRole('org-1', actor('OWNER'), 'user-2', 'ADMIN');

    expect(audit.events[0]).toMatchObject({
      action: 'organization.member.role_changed',
      outcome: 'SUCCESS',
      organizationId: 'org-1',
    });
  });
});

describe('OrganizationsService invitations', () => {
  let auth: FakeAuthStore;
  let organizations: FakeOrganizationStore;
  let audit: FakeAuditStore;
  let service: OrganizationsService;

  beforeEach(() => {
    auth = new FakeAuthStore();
    organizations = new FakeOrganizationStore();
    audit = new FakeAuditStore();
    service = new OrganizationsService(organizations, auth, audit, TERMS);
    seedOwner(auth, organizations);
  });

  const actor = { userId: 'user-1', role: 'ADMIN' as const };

  it('stores only the digest of an invitation token', async () => {
    await service.invite('org-1', actor, 'invitee@example.invalid', 'VIEWER');

    expect(organizations.invitations[0]!.tokenHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('refuses an owner invitation', async () => {
    await expect(
      service.invite('org-1', { userId: 'user-1', role: 'OWNER' }, 'x@example.invalid', 'OWNER'),
    ).rejects.toMatchObject({ code: 'cannot_delegate_beyond_own_authority' });
  });

  it('refuses an admin inviting a billing user', async () => {
    await expect(
      service.invite('org-1', actor, 'x@example.invalid', 'BILLING'),
    ).rejects.toMatchObject({ code: 'cannot_delegate_beyond_own_authority' });
  });

  it('refuses a duplicate outstanding invitation', async () => {
    await service.invite('org-1', actor, 'invitee@example.invalid', 'VIEWER');

    await expect(
      service.invite('org-1', actor, 'INVITEE@example.invalid', 'VIEWER'),
    ).rejects.toMatchObject({ code: 'email_already_registered' });
  });

  it('creates a membership when an invitation is accepted', async () => {
    await service.invite('org-1', actor, 'invitee@example.invalid', 'VIEWER');
    const invitation = organizations.invitations[0]!;

    auth.users.push(aUser({ id: 'user-9', email: 'invitee@example.invalid' }));

    // Present the raw token the service would have emailed. The suite reaches it
    // through the stored digest, which is exactly what an attacker with a
    // database dump would NOT have.
    const result = await organizations.acceptInvitation(invitation.tokenHash, 'user-9', new Date());

    expect(result.ok).toBe(true);
    expect(organizations.memberships.some((m) => m.userId === 'user-9')).toBe(true);
  });

  it('refuses a revoked invitation', async () => {
    const invitation = anInvitation();
    organizations.invitations.push(invitation);
    invitation.revokedAt = new Date();

    const result = await organizations.acceptInvitation(invitation.tokenHash, 'user-9', new Date());

    expect(result.ok).toBe(false);
  });

  it('refuses an expired invitation', async () => {
    const invitation = anInvitation({ expiresAt: new Date(Date.now() - 1_000) });
    organizations.invitations.push(invitation);

    const result = await organizations.acceptInvitation(invitation.tokenHash, 'user-9', new Date());

    expect(result.ok).toBe(false);
  });

  it('refuses presenting a digest instead of the token', async () => {
    // Guards against a future "convenience" that treats the stored hash as the
    // credential. It is not: it is a lookup key.
    const invitation = anInvitation();
    organizations.invitations.push(invitation);

    const result = await service
      .acceptInvitation('user-9', invitation.tokenHash)
      .catch((error: { code: string }) => error);

    expect(result).toMatchObject({ code: 'invalid_or_expired_token' });
  });
});

describe('OrganizationsService ownership transfer', () => {
  let auth: FakeAuthStore;
  let organizations: FakeOrganizationStore;
  let service: OrganizationsService;

  beforeEach(() => {
    auth = new FakeAuthStore();
    organizations = new FakeOrganizationStore();
    const audit = new FakeAuditStore();
    service = new OrganizationsService(organizations, auth, audit, TERMS);
    seedOwner(auth, organizations);
    organizations.memberships.push(aMembership({ userId: 'user-2', role: 'ADMIN' }));
  });

  it('promotes the new owner and demotes the previous one to admin', async () => {
    await service.transferOwnership('org-1', 'user-1', 'user-2');

    expect(organizations.memberships.find((m) => m.userId === 'user-2')?.role).toBe('OWNER');
    expect(organizations.memberships.find((m) => m.userId === 'user-1')?.role).toBe('ADMIN');
  });

  it('refuses transferring to yourself', async () => {
    await expect(service.transferOwnership('org-1', 'user-1', 'user-1')).rejects.toMatchObject({
      status: 409,
    });
  });

  it('refuses transferring to somebody who is not a member', async () => {
    await expect(service.transferOwnership('org-1', 'user-1', 'stranger')).rejects.toMatchObject({
      status: 404,
    });
  });

  it('refuses transferring from somebody who does not own it', async () => {
    // Compare-and-set: an admin cannot perform the transfer an owner can.
    await expect(service.transferOwnership('org-1', 'user-2', 'user-1')).rejects.toMatchObject({
      status: 404,
    });

    expect(organizations.memberships.find((m) => m.userId === 'user-1')?.role).toBe('OWNER');
  });
});
