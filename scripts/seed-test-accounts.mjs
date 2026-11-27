import process from 'node:process';
import { format } from 'node:util';
import { randomUUID } from 'node:crypto';
import { hashPassword } from '@truevine/auth/passwords';
import { createDatabaseClient } from '@truevine/database';

const DATABASE_URL = required('DATABASE_URL');

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

async function main() {
  const db = createDatabaseClient(DATABASE_URL, { log: [] });
  
  try {
    // Check if Platform Owner already exists
    const existingOwner = await db.user.findFirst({
      where: { platformRole: { role: 'PLATFORM_OWNER' } },
      include: { platformRole: true }
    });
    
    if (existingOwner) {
      process.stdout.write(format('Platform Owner already exists:', existingOwner.email) + '\n');
    } else {
      // Create Platform Owner
      const ownerId = randomUUID();
      const ownerEmail = 'qa-platform-owner@example.invalid';
      const passwordHash = await hashPassword(required('QA_FIXTURE_PASSWORD'));
      
      await db.$transaction(async (tx) => {
        await tx.user.create({
          data: { id: ownerId, email: ownerEmail, passwordHash, status: 'ACTIVE' }
        });
        await tx.platformRoleAssignment.create({
          data: { userId: ownerId, role: 'PLATFORM_OWNER', grantedByUserId: ownerId }
        });
        await tx.identityAuditEvent.create({
          data: {
            id: randomUUID(),
            actorUserId: ownerId,
            action: 'auth.owner_provisioned',
            outcome: 'SUCCESS',
            metadata: {
              source: 'test_seeder',
              actorKind: 'local_operator',
              operatorReference: 'test-seeder',
              actorAuthentication: 'operating_system',
            }
          }
        });
      });
      process.stdout.write(format('Created Platform Owner:', ownerEmail) + '\n');
    }

    // Check if Support Admin already exists
    const existingSupport = await db.user.findFirst({
      where: { platformRole: { role: 'SUPPORT_ADMIN' } },
      include: { platformRole: true }
    });

    if (existingSupport) {
      process.stdout.write(format('Support Admin already exists:', existingSupport.email) + '\n');
    } else {
      // Create Support Admin
      const supportId = randomUUID();
      const supportEmail = 'qa-support-admin@example.invalid';
      const passwordHash = await hashPassword(required('QA_FIXTURE_PASSWORD'));
      
      // Get the Platform Owner to use as grantor
      const owner = await db.user.findFirst({
        where: { platformRole: { role: 'PLATFORM_OWNER' } },
        select: { id: true }
      });
      
      await db.$transaction(async (tx) => {
        await tx.user.create({
          data: { id: supportId, email: supportEmail, passwordHash, status: 'ACTIVE' }
        });
        await tx.platformRoleAssignment.create({
          data: { userId: supportId, role: 'SUPPORT_ADMIN', grantedByUserId: owner.id }
        });
        await tx.identityAuditEvent.create({
          data: {
            id: randomUUID(),
            actorUserId: owner.id,
            action: 'qa.role_account.provisioned',
            outcome: 'SUCCESS',
            metadata: {
              source: 'test_seeder',
              actorKind: 'local_operator',
              targetUserId: supportId,
              role: 'SUPPORT_ADMIN',
              organizationId: null
            }
          }
        });
      });
      process.stdout.write(format('Created Support Admin:', supportEmail) + '\n');
    }

    process.stdout.write(format('Test accounts seeded successfully!') + '\n');
  } finally {
    await db.$disconnect();
  }
}

main().catch(() => {
  process.stderr.write('Seeding failed.\n');
  process.exit(1);
});