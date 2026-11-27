/**
 * W5-02F QA account provisioning script.
 *
 * Creates synthetic QA accounts exclusively in the isolated test database
 * truevine_payment_e2e. Never writes to truevine_voice.
 *
 * Run with:
 *   DATABASE_URL=postgresql://truevine:truevine@localhost:55432/truevine_payment_e2e?schema=public
 *   node scripts/testing/w5-02f-provision-qa.mjs
 */

import { createDatabaseClient } from '@truevine/database';
import { randomUUID } from 'node:crypto';
import { hash as argonHash } from '@node-rs/argon2';

const ARGON2_OPTIONS = {
  algorithm: 2,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
  outputLen: 32,
};

async function hashPassword(password) {
  return argonHash(password, ARGON2_OPTIONS);
}

async function main() {
  const prisma = createDatabaseClient(process.env.DATABASE_URL);
  const ts = Date.now();

  try {
    // Create owner user first
    const ownerUserId = randomUUID();
    const ownerHash = await hashPassword('qa-payment-owner-secret-0001');
    await prisma.user.create({
      data: {
        id: ownerUserId,
        email: `qa-payment-owner-${ts}@example.invalid`,
        passwordHash: ownerHash,
      },
    });

    // Create owner organization with nested OWNER membership
    const ownerOrgId = randomUUID();
    await prisma.organization.create({
      data: {
        id: ownerOrgId,
        slug: `qa-payment-owner-${ts}`,
        name: 'QA Payment Owner Org',
        memberships: {
          create: {
            userId: ownerUserId,
            role: 'OWNER',
          },
        },
      },
    });

    // Create viewer user
    const viewerUserId = randomUUID();
    const viewerHash = await hashPassword('qa-payment-viewer-secret-0002');
    await prisma.user.create({
      data: {
        id: viewerUserId,
        email: `qa-payment-viewer-${ts}@example.invalid`,
        passwordHash: viewerHash,
      },
    });

    await prisma.membership.create({
      data: {
        organizationId: ownerOrgId,
        userId: viewerUserId,
        role: 'VIEWER',
      },
    });

    // Create other-organization user first
    const otherUserId = randomUUID();
    const otherHash = await hashPassword('qa-payment-other-secret-0003');
    await prisma.user.create({
      data: {
        id: otherUserId,
        email: `qa-payment-other-org-${ts}@example.invalid`,
        passwordHash: otherHash,
      },
    });

    // Create other organization with nested OWNER membership
    const otherOrgId = randomUUID();
    await prisma.organization.create({
      data: {
        id: otherOrgId,
        slug: `qa-payment-other-${ts}`,
        name: 'QA Payment Other Org',
        memberships: {
          create: {
            userId: otherUserId,
            role: 'OWNER',
          },
        },
      },
    });

    return { ownerOrgId, viewerUserId, otherOrgId, ts };
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((_error) => {
  process.exit(1);
});