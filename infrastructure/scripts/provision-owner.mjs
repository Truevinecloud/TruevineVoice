/**
 * Operator-only provisioning of the FIRST Organization Owner.
 *
 * Plain JavaScript on purpose: this is operator tooling run directly by Node, and
 * giving it a build step would mean a compiled artefact an operator might run
 * that is older than the source they read. Types live in the sibling `.d.mts`.
 *
 * WHY THIS EXISTS AS A SCRIPT
 * ---------------------------
 * There is no public sign-up endpoint, and there must never be one: anybody who
 * can register can create an organization and thereby become its Owner. The
 * first Owner of a tenant is a deliberate act by somebody with shell access to
 * the environment, so it lives in a script an operator runs, not an endpoint.
 *
 * THE ACCOUNT IS BORN UNUSABLE
 * ----------------------------
 * The provisioned user is created with the password hash of 256 random bytes, so
 * no password the operator could choose - and no password an attacker could
 * guess - will authenticate it. What the operator receives instead is a
 * **single-use activation token**, written to a file with mode 0600 whose path
 * is printed.
 *
 * That is what "secure account activation" means here. The operator never
 * chooses a credential, never knows one, and never transmits one. The owner sets
 * their own password by consuming the token, through exactly the same code path
 * as a forgotten-password reset.
 *
 * WHY NOTHING IS AN ARGUMENT
 * ---------------------------
 * Command-line arguments are visible to every other process through `ps`, and
 * land in shell history. Secrets are written to a `0600` file and only the path
 * is printed.
 *
 * WHY IT IS SAFE TO RUN TWICE
 * ----------------------------
 * Re-running against an existing address is refused, never a silent password
 * reset. A provisioning script that quietly changes a credential is a
 * credential-leak tool with extra steps.
 */

import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { userInfo } from 'node:os';

import { checkEmail, generateToken, hashToken, sensitiveAudit } from '@truevine/auth';
import { hashPassword } from '@truevine/auth/passwords';
import { createDatabaseClient } from '@truevine/database';

/** Why provisioning was refused. Every value is safe to print. */
export const PROVISION_REFUSALS = {
  invalidEmail: 'invalid_email',
  invalidSlug: 'invalid_slug',
  emailAlreadyRegistered: 'email_already_registered',
  organizationAlreadyHasMembers: 'organization_already_has_members',
};

/** The slug grammar: lowercase letters, digits and single hyphens. */
const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** How long an activation token stays valid. */
const ACTIVATION_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Creates the first Organization Owner of a new, or memberless, organization.
 *
 * Returns a discriminated result rather than throwing, so a caller can render a
 * refusal without a stack trace reaching a terminal that is being pasted into a
 * ticket.
 *
 * @param {{email: string, organizationSlug: string, organizationName?: string,
 *          activationDirectory: string, applicationBaseUrl: string}} options
 * @param {{databaseUrl: string}} dependencies
 * @returns {Promise<object>} a success or refusal outcome
 */
export async function provisionOwner(options, dependencies) {
  const email = checkEmail(options.email);

  if (!email.ok) {
    return {
      ok: false,
      reason: PROVISION_REFUSALS.invalidEmail,
      detail: 'That email address is not valid.',
    };
  }

  if (!SLUG_PATTERN.test(options.organizationSlug)) {
    return {
      ok: false,
      reason: PROVISION_REFUSALS.invalidSlug,
      detail:
        'The organization slug must be 1 to 63 lowercase letters, digits or hyphens, and must not begin or end with a hyphen.',
    };
  }

  const database = createDatabaseClient(dependencies.databaseUrl);

  try {
    const existingUser = await database.user.findUnique({ where: { email: email.value } });

    if (existingUser) {
      return {
        ok: false,
        reason: PROVISION_REFUSALS.emailAlreadyRegistered,
        detail:
          'An account already exists for that address. This script never changes an existing credential; use the password-reset flow, or the ownership-transfer flow if they already belong to the organization.',
      };
    }

    const existingOrganization = await database.organization.findUnique({
      where: { slug: options.organizationSlug },
      include: { memberships: { select: { userId: true } } },
    });

    // An organization with members already has an owner. Attaching a second one
    // here would be a privilege escalation performed by a script.
    if (existingOrganization && existingOrganization.memberships.length > 0) {
      return {
        ok: false,
        reason: PROVISION_REFUSALS.organizationAlreadyHasMembers,
        detail:
          'That organization already has members, so it already has an owner. Transfer ownership through the application instead.',
      };
    }

    const userId = randomUUID();
    const organizationId = existingOrganization?.id ?? randomUUID();
    const rawToken = generateToken();
    const expiresAt = new Date(Date.now() + ACTIVATION_WINDOW_MS);

    await database.$transaction(async (tx) => {
      // The hash of 256 random bytes. Deliberately NOT a password the operator
      // supplied: the account has no usable password until the activation token
      // is consumed, so nothing the operator types can ever sign in as this user.
      const unusablePasswordHash = await hashPassword(randomBytes(32).toString('base64url'));

      await tx.user.create({
        data: { id: userId, email: email.value, passwordHash: unusablePasswordHash },
      });

      if (!existingOrganization) {
        await tx.organization.create({
          data: {
            id: organizationId,
            slug: options.organizationSlug,
            name: options.organizationName ?? options.organizationSlug,
          },
        });
      }

      await tx.membership.create({
        data: { organizationId, userId, role: 'OWNER' },
      });

      await tx.passwordResetToken.create({
        data: {
          id: randomUUID(),
          userId,
          tokenHash: hashToken(rawToken),
          expiresAt,
        },
      });

      await tx.identityAuditEvent.create({
        data: {
          actorUserId: userId,
          action: 'auth.owner_provisioned',
          outcome: 'SUCCESS',
          metadata: {
            organizationId,
            organizationSlug: options.organizationSlug,
            actorKind: 'local_operator',
            operatorReference: userInfo().username,
            actorAuthentication: 'operating_system',
            ...sensitiveAudit({
              targetType: 'membership',
              targetId: userId,
              before: null,
              change: { role: 'OWNER' },
              after: { role: 'OWNER', organizationId },
              reasonCode: 'operator_owner_provisioning',
            }),
          },
        },
      });
    });

    const activationFile = writeActivationFile({
      directory: options.activationDirectory,
      email: email.value,
      organizationSlug: options.organizationSlug,
      rawToken,
      baseUrl: options.applicationBaseUrl,
      expiresAt,
    });

    return {
      ok: true,
      userId,
      organizationId,
      organizationSlug: options.organizationSlug,
      organizationCreated: !existingOrganization,
      activationFile,
      activationExpiresAt: expiresAt,
    };
  } finally {
    await database.$disconnect();
  }
}

/**
 * Writes the activation token to a private file and returns its path.
 *
 * `0600` is part of the control: the file grants account takeover to whoever
 * reads it. The directory is created `0700` for the same reason.
 */
function writeActivationFile(input) {
  mkdirSync(input.directory, { recursive: true, mode: 0o700 });

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = join(input.directory, `owner-${input.organizationSlug}-${stamp}.txt`);

  const url = `${input.baseUrl.replace(/\/$/, '')}/set-password?token=${input.rawToken}`;

  writeFileSync(
    file,
    [
      'Truevine Voice - owner activation',
      '',
      `Email:              ${input.email}`,
      `Organization slug:  ${input.organizationSlug}`,
      `Expires:            ${input.expiresAt.toISOString()}`,
      '',
      'Open this link in a private window to set the first password:',
      '',
      url,
      '',
      'The account has NO usable password until this link is used.',
      'The link can be used once. It expires in 24 hours.',
      'Delete this file once the link has been used.',
      '',
    ].join('\n'),
    { encoding: 'utf8', mode: 0o600 },
  );

  return file;
}

/** The directory the CLI writes activation files into. */
export function defaultActivationDirectory(baseDirectory = process.cwd()) {
  return join(baseDirectory, '.owner-activation');
}
