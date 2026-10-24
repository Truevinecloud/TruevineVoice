/** PostgreSQL constraints for audio tenancy and immutable usage evidence. */
import { randomUUID } from 'node:crypto';

import { createDatabaseClient, type PrismaClient } from '@truevine/database';
import { loadEnvFiles, requireEnv } from '@truevine/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

let database: PrismaClient;
const organizationA = randomUUID();
const organizationB = randomUUID();
const userId = randomUUID();
const assetId = randomUUID();
const run = randomUUID().replace(/-/g, '').slice(0, 10);

beforeAll(async () => {
  loadEnvFiles();
  database = createDatabaseClient(requireEnv('DATABASE_URL'));
  await database.organization.createMany({
    data: [
      { id: organizationA, slug: `audio-a-${run}`, name: 'Audio E2E A' },
      { id: organizationB, slug: `audio-b-${run}`, name: 'Audio E2E B' },
    ],
  });
  await database.user.create({
    data: {
      id: userId,
      email: `audio-${run}@example.invalid`,
      passwordHash: 'e2e-only-not-a-credential',
    },
  });
  await database.membership.create({
    data: { organizationId: organizationA, userId, role: 'OWNER' },
  });
  await database.membership.create({
    data: { organizationId: organizationB, userId, role: 'ADMIN' },
  });
  await database.audioAsset.create({
    data: {
      organizationId: organizationA,
      id: assetId,
      createdById: userId,
      name: 'Synthetic recording',
      source: 'RECORDING',
      mimeType: 'audio/webm',
      storageKey: `${organizationA}/audio/${assetId}.webm`,
      checksumSha256: 'a'.repeat(64),
      byteSize: 4n,
    },
  });
}, 60_000);

afterAll(async () => {
  await database?.$disconnect();
});

describe('audio PostgreSQL constraints', () => {
  it('scopes asset reads by the composite organization key', async () => {
    expect(
      await database.audioAsset.findUnique({
        where: { organizationId_id: { organizationId: organizationB, id: assetId } },
      }),
    ).toBeNull();
    expect(
      await database.audioAsset.findUnique({
        where: { organizationId_id: { organizationId: organizationA, id: assetId } },
      }),
    ).not.toBeNull();
  });

  it('rejects a campaign reference that crosses organization boundaries', async () => {
    await expect(
      database.campaign.create({
        data: {
          organizationId: organizationB,
          id: randomUUID(),
          name: 'Foreign audio reference',
          status: 'DRAFT',
          createdById: userId,
          audioOrganizationId: organizationA,
          audioAssetId: assetId,
        },
      }),
    ).rejects.toThrow();
  });

  it('rejects usage records with a mismatched tenant and prevents usage mutation', async () => {
    await expect(
      database.audioAssetUsage.create({
        data: {
          organizationId: organizationB,
          assetId,
          actorUserId: userId,
          action: 'RECORDING_CREATED',
          byteSize: 4n,
        },
      }),
    ).rejects.toThrow();
    const usage = await database.audioAssetUsage.create({
      data: {
        organizationId: organizationA,
        assetId,
        actorUserId: userId,
        action: 'RECORDING_CREATED',
        byteSize: 4n,
      },
    });
    await expect(
      database.audioAssetUsage.update({
        where: { organizationId_id: { organizationId: organizationA, id: usage.id } },
        data: { byteSize: 5n },
      }),
    ).rejects.toThrow(/append-only/);
  });
});
