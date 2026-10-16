/**
 * Operator provisioning of the first Organization Owner, against live
 * PostgreSQL.
 *
 * Runs against an isolated database - the same local container every other
 * end-to-end suite uses, with unique identifiers per run. Requires:
 *
 *   npm run infra:up
 *   npm run test:e2e
 *
 * These assertions matter because the provisioning script is the ONLY way the
 * first Owner of a tenant can come into existence. If it silently created a weak
 * account, or could be pointed at somebody else's tenant, there would be no
 * second line of defence behind it.
 */

import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { verifyPassword } from '@truevine/auth/passwords';
import { loadEnvFiles, requireEnv } from '@truevine/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabaseClient, type PrismaClient } from '../src/index.js';

import { provisionOwner } from '../../../infrastructure/scripts/provision-owner.mjs';

const RUN = randomUUID().slice(0, 8);

let database: PrismaClient;
let activationDirectory: string;

beforeAll(() => {
  loadEnvFiles();
  database = createDatabaseClient(requireEnv('DATABASE_URL'));
  activationDirectory = mkdtempSync(join(tmpdir(), 'tv-provision-'));
});

afterAll(async () => {
  await database?.$disconnect();
  rmSync(activationDirectory, { recursive: true, force: true });
});

/** Unique per run, so fixtures never collide. */
const emailFor = (label: string) => `provision-${label}-${RUN}@example.invalid`;
const slugFor = (label: string) => `prov-${label}-${RUN}`;

/** Reads the activation link out of the file the script wrote. */
function readActivationToken(file: string): string {
  const match = /\/set-password\?token=([A-Za-z0-9_-]+)/.exec(readFileSync(file, 'utf8'));

  if (!match?.[1]) throw new Error('No activation token in the file.');

  return match[1];
}

describe('provisioning the first Organization Owner', () => {
  it('creates the user, the organization and the OWNER membership', async () => {
    const slug = slugFor('first');

    const outcome = await provisionOwner(
      {
        email: emailFor('first'),
        organizationSlug: slug,
        organizationName: 'Provisioned Org',
        activationDirectory,
        applicationBaseUrl: 'http://localhost:3000',
      },
      { databaseUrl: requireEnv('DATABASE_URL') },
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    expect(outcome.organizationCreated).toBe(true);

    const membership = await database.membership.findUnique({
      where: { organizationId_userId: { organizationId: outcome.organizationId, userId: outcome.userId } },
    });

    expect(membership?.role).toBe('OWNER');
  });

  it('creates an account with NO usable password', async () => {
    // The account is created from the hash of random bytes. The operator never
    // chooses a credential, so there is nothing for them to leak or transmit.
    const outcome = await provisionOwner(
      {
        email: emailFor('unusable'),
        organizationSlug: slugFor('unusable'),
        activationDirectory,
        applicationBaseUrl: 'http://localhost:3000',
      },
      { databaseUrl: requireEnv('DATABASE_URL') },
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    const user = await database.user.findUnique({ where: { id: outcome.userId } });

    for (const guess of ['', 'password', 'owner', 'truevine', 'Password123!']) {
      expect(await verifyPassword(user?.passwordHash ?? '', guess)).toBe(false);
    }
  });

  it('writes a single-use activation token that is stored hashed', async () => {
    const outcome = await provisionOwner(
      {
        email: emailFor('token'),
        organizationSlug: slugFor('token'),
        activationDirectory,
        applicationBaseUrl: 'http://localhost:3000',
      },
      { databaseUrl: requireEnv('DATABASE_URL') },
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    const stored = await database.passwordResetToken.findMany({
      where: { userId: outcome.userId },
    });

    expect(stored).toHaveLength(1);
    expect(stored[0]?.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored[0]?.usedAt).toBeNull();

    // The raw token appears in the file, and only there.
    const raw = readActivationToken(outcome.activationFile);
    expect(stored[0]?.tokenHash).not.toBe(raw);
  });

  it('writes the activation file readable only by its owner', async () => {
    const outcome = await provisionOwner(
      {
        email: emailFor('perms'),
        organizationSlug: slugFor('perms'),
        activationDirectory,
        applicationBaseUrl: 'http://localhost:3000',
      },
      { databaseUrl: requireEnv('DATABASE_URL') },
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    // The file grants account takeover to whoever reads it.
    if (process.platform !== 'win32') {
      expect(statSync(outcome.activationFile).mode & 0o777).toBe(0o600);
    }
  });

  it('never writes a password into the activation file', async () => {
    const outcome = await provisionOwner(
      {
        email: emailFor('nopw'),
        organizationSlug: slugFor('nopw'),
        activationDirectory,
        applicationBaseUrl: 'http://localhost:3000',
      },
      { databaseUrl: requireEnv('DATABASE_URL') },
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    const contents = readFileSync(outcome.activationFile, 'utf8');

    expect(contents).toMatch(/NO usable password/i);
    expect(contents).not.toMatch(/argon2/i);
  });

  it('records a provisioning audit event', async () => {
    const outcome = await provisionOwner(
      {
        email: emailFor('audit'),
        organizationSlug: slugFor('audit'),
        activationDirectory,
        applicationBaseUrl: 'http://localhost:3000',
      },
      { databaseUrl: requireEnv('DATABASE_URL') },
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    const events = await database.identityAuditEvent.findMany({
      where: { actorUserId: outcome.userId },
    });

    expect(events.map((event) => event.action)).toContain('auth.owner_provisioned');
  });
});

describe('provisioning refusals', () => {
  it('refuses a duplicate email address', async () => {
    const email = emailFor('dupe');
    const slug = slugFor('dupe-a');

    const first = await provisionOwner(
      { email, organizationSlug: slug, activationDirectory, applicationBaseUrl: 'http://localhost:3000' },
      { databaseUrl: requireEnv('DATABASE_URL') },
    );
    expect(first.ok).toBe(true);

    const second = await provisionOwner(
      {
        email: email.toUpperCase(),
        organizationSlug: slugFor('dupe-b'),
        activationDirectory,
        applicationBaseUrl: 'http://localhost:3000',
      },
      { databaseUrl: requireEnv('DATABASE_URL') },
    );

    // Case-insensitively refused: `citext` means these are the same account.
    expect(second).toMatchObject({ ok: false, reason: 'email_already_registered' });
  });

  it('does not change an existing password when refusing a duplicate', async () => {
    const email = emailFor('nopwchange');
    const slug = slugFor('nopwchange');

    await provisionOwner(
      { email, organizationSlug: slug, activationDirectory, applicationBaseUrl: 'http://localhost:3000' },
      { databaseUrl: requireEnv('DATABASE_URL') },
    );

    const user = await database.user.findUnique({ where: { email } });
    const before = user?.passwordHash;

    await provisionOwner(
      {
        email,
        organizationSlug: slugFor('nopwchange-2'),
        activationDirectory,
        applicationBaseUrl: 'http://localhost:3000',
      },
      { databaseUrl: requireEnv('DATABASE_URL') },
    );

    const after = await database.user.findUnique({ where: { email } });
    expect(after?.passwordHash).toBe(before);
  });

  it('refuses to join an organization that already has members', async () => {
    const slug = slugFor('owned');
    const owner = await provisionOwner(
      {
        email: emailFor('owned-owner'),
        organizationSlug: slug,
        activationDirectory,
        applicationBaseUrl: 'http://localhost:3000',
      },
      { databaseUrl: requireEnv('DATABASE_URL') },
    );
    expect(owner.ok).toBe(true);
    if (!owner.ok) return;

    // A second Owner would be a privilege escalation performed by a script.
    const second = await provisionOwner(
      {
        email: emailFor('intruder'),
        organizationSlug: slug,
        activationDirectory,
        applicationBaseUrl: 'http://localhost:3000',
      },
      { databaseUrl: requireEnv('DATABASE_URL') },
    );

    expect(second).toMatchObject({
      ok: false,
      reason: 'organization_already_has_members',
    });
  });

  it('joins an existing organization that has no members', async () => {
    const slug = slugFor('empty');

    await database.organization.create({ data: { slug, name: 'Empty Org' } });

    const outcome = await provisionOwner(
      {
        email: emailFor('joiner'),
        organizationSlug: slug,
        activationDirectory,
        applicationBaseUrl: 'http://localhost:3000',
      },
      { databaseUrl: requireEnv('DATABASE_URL') },
    );

    expect(outcome).toMatchObject({ ok: true, organizationCreated: false, organizationSlug: slug });
  });

  it('refuses an invalid email address', async () => {
    const outcome = await provisionOwner(
      {
        email: 'not-an-email',
        organizationSlug: slugFor('bademail'),
        activationDirectory,
        applicationBaseUrl: 'http://localhost:3000',
      },
      { databaseUrl: requireEnv('DATABASE_URL') },
    );

    expect(outcome).toMatchObject({ ok: false, reason: 'invalid_email' });
  });

  it('refuses a slug that is not URL safe', async () => {
    for (const slug of ['Has Uppercase', 'has space', '-leading', 'trailing-', 'a'.repeat(64)]) {
      const outcome = await provisionOwner(
        {
          email: emailFor(`slug-${slug.length}`),
          organizationSlug: slug,
          activationDirectory,
          applicationBaseUrl: 'http://localhost:3000',
        },
        { databaseUrl: requireEnv('DATABASE_URL') },
      );

      expect(outcome, slug).toMatchObject({ ok: false, reason: 'invalid_slug' });
    }
  });

  it('accepts a slug at the length boundary', async () => {
    // 63 characters, the column limit. The suffix keeps it unique per run:
    // a fixed slug would collide with the organization the previous run left
    // behind, and the script would correctly refuse to join one that has members.
    const outcome = await provisionOwner(
      {
        email: emailFor('slugmax'),
        organizationSlug: `a${'b'.repeat(50 - RUN.length)}${RUN}c`,
        activationDirectory,
        applicationBaseUrl: 'http://localhost:3000',
      },
      { databaseUrl: requireEnv('DATABASE_URL') },
    );

    expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
  });
});