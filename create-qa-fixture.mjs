import process from 'node:process';
import { format } from 'node:util';
import { randomUUID } from 'node:crypto';
import { hashPassword } from '@truevine/auth/passwords';
import { createDatabaseClient } from '@truevine/database';

/**
 * Development-only QA fixture for creating test Platform Owner and Support Admin accounts.
 * 
 * SAFEGUARDS:
 * - Only runs against databases named `truevine_bootstrap_test_*` (16 hex chars)
 * - Requires `QA_FIXTURE_ALLOW=true` environment variable
 * - Validates database name before any write operations
 * - Will NOT run against `truevine_voice` or any production-like database name
 */

// Expected test database name pattern
const TEST_DB_PATTERN = /^truevine_bootstrap_test_[0-9a-f]{16}$/;

// Extract database name from DATABASE_URL
function extractDatabaseName(url) {
  try {
    const parsed = new URL(url);
    // Remove leading slash from pathname
    return parsed.pathname.slice(1).split('?')[0];
  } catch {
    return null;
  }
}

// Validate we're targeting a disposable test database
function validateTestDatabase(url) {
  const dbName = extractDatabaseName(url);
  if (!dbName) {
    throw new Error('Could not extract database name from DATABASE_URL');
  }
  if (!TEST_DB_PATTERN.test(dbName)) {
    throw new Error(
      `REFUSING TO RUN: Database "${dbName}" does not match test database pattern ` +
      `"truevine_bootstrap_test_<16-hex-chars>". ` +
      'This fixture only runs against disposable test databases. ' +
      'Set QA_FIXTURE_ALLOW=true and use a properly named test database.'
    );
  }
  if (process.env.QA_FIXTURE_ALLOW !== 'true') {
    throw new Error(
      'REFUSING TO RUN: QA_FIXTURE_ALLOW environment variable not set to "true". ' +
      'This fixture provisions privileged platform roles (PLATFORM_OWNER, SUPPORT_ADMIN). ' +
      'Only run in isolated disposable test environments.'
    );
  }
  process.stdout.write(format('✓ Test database validation passed:', dbName) + '\n');
}

// Use the isolated test database
const DATABASE_URL = required('DATABASE_URL');

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

async function createQAFixture() {
  // Validate before connecting
  validateTestDatabase(DATABASE_URL);
  
  const db = createDatabaseClient(DATABASE_URL);
  
  try {
    // Test connection first
    await db.$queryRaw`SELECT 1`;
    process.stdout.write(format('Database connection OK') + '\n');
    
    await db.$transaction(
      async (tx) => {
        // Check if Platform Owner already exists
        const existingPO = await tx.user.findUnique({ 
          where: { email: 'qa-platform-owner@truevoice.com' },
          include: { platformRole: true }
        });
        
        let platformOwnerId;
        if (existingPO) {
          platformOwnerId = existingPO.id;
          process.stdout.write(format('Platform Owner already exists:', platformOwnerId) + '\n');
        } else {
          // Create Platform Owner
          platformOwnerId = randomUUID();
          const poPasswordHash = await hashPassword(required('QA_FIXTURE_PASSWORD'));
          
          await tx.user.create({
            data: {
              id: platformOwnerId,
              email: 'qa-platform-owner@truevoice.com',
              passwordHash: poPasswordHash,
              status: 'ACTIVE',
              termsAcceptances: {
                create: {
                  termsVersion: '2026-10-01',
                }
              }
            }
          });
          
          await tx.platformRoleAssignment.create({
            data: {
              userId: platformOwnerId,
              role: 'PLATFORM_OWNER',
            }
          });
          
          process.stdout.write(format('Created Platform Owner:', platformOwnerId) + '\n');
        }
        
        // Create Support Admin
        const existingSA = await tx.user.findUnique({ 
          where: { email: 'qa-support-admin@truevoice.com' },
          include: { platformRole: true }
        });
        
        if (existingSA) {
          process.stdout.write(format('Support Admin already exists:', existingSA.id) + '\n');
        } else {
          const saId = randomUUID();
          const saPasswordHash = await hashPassword(required('QA_FIXTURE_PASSWORD'));
          
          await tx.user.create({
            data: {
              id: saId,
              email: 'qa-support-admin@truevoice.com',
              passwordHash: saPasswordHash,
              status: 'ACTIVE',
              termsAcceptances: {
                create: {
                  termsVersion: '2026-10-01',
                }
              }
            }
          });
          
          await tx.platformRoleAssignment.create({
            data: {
              userId: saId,
              role: 'SUPPORT_ADMIN',
              grantedByUserId: platformOwnerId,
            }
          });
          
          process.stdout.write(format('Created Support Admin:', saId) + '\n');
        }
        
        // Verify roles
        const po = await tx.user.findUnique({ 
          where: { email: 'qa-platform-owner@truevoice.com' },
          include: { platformRole: true }
        });
        const sa = await tx.user.findUnique({ 
          where: { email: 'qa-support-admin@truevoice.com' },
          include: { platformRole: true }
        });
        
        process.stdout.write(format('\n=== VERIFICATION ===') + '\n');
        process.stdout.write(format('Platform Owner:', po?.email, '| Role:', po?.platformRole?.role, '| Status:', po?.status) + '\n');
        process.stdout.write(format('Support Admin:', sa?.email, '| Role:', sa?.platformRole?.role, '| Status:', sa?.status) + '\n');
      },
      { timeout: 60000 }
    );
  } finally {
    await db.$disconnect();
  }
}

createQAFixture().catch(() => { process.stderr.write('QA fixture failed.\n'); process.exitCode = 1; });