import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * W6-03 Backup Restore Drill — deterministic static assertions.
 *
 * These tests verify the backup/restore drill tooling by inspecting script
 * text rather than executing against a live database. They run everywhere the
 * Vitest suite runs, including Windows workstations without Docker or
 * PostgreSQL.
 *
 * Covered:
 *   - W1-10 backup readiness (backup.sh, restore.sh, lib/common.sh exist)
 *   - Restore safety model (verify-only default, isolated instance,
 *     network isolation, no production database access)
 *   - Integrity validation: organizations, users, wallet balances,
 *     financial ledger records, campaign records, campaign recipients,
 *     tenant isolation, database relationships, schema and migration
 *     compatibility
 *   - Backup checksum and integrity verification
 *   - Restore duration measurement
 *   - SQL query validity for tenant isolation checks
 */

const BACKUP_DIR = resolve(process.cwd(), 'infrastructure/backup');
const SCRIPTS_DIR = resolve(process.cwd(), 'infrastructure/scripts');
const read = (name: string): string => readFileSync(resolve(BACKUP_DIR, name), 'utf8');
const readScript = (name: string): string => readFileSync(resolve(SCRIPTS_DIR, name), 'utf8');

const dbVerify = readScript('db-verify.sh');
const backup = read('backup.sh');
const restore = read('restore.sh');
const common = read('lib/common.sh');

describe('W1-10 backup readiness', () => {
  it('backup.sh exists and is executable-readable', () => {
    expect(backup).toContain('#!/usr/bin/env bash');
    expect(backup).toContain('pg_dump');
    expect(backup).toContain('-Fc');
  });

  it('restore.sh exists and restores into isolated instance', () => {
    expect(restore).toContain('#!/usr/bin/env bash');
    expect(restore).toContain('pg_restore');
    expect(restore).toContain('--no-owner --no-privileges');
  });

  it('lib/common.sh provides encryption, checksums and secret gate', () => {
    expect(common).toContain('encrypt_stream');
    expect(common).toContain('decrypt_file');
    expect(common).toContain('verify_sha256');
    expect(common).toContain('sha256_of');
    expect(common).toContain('assert_no_secrets');
  });

  it('backup.sh only reads the database (no DDL/DML)', () => {
    expect(backup).toContain('pg_dump');
    for (const forbidden of ['DROP ', 'DROP TABLE', 'TRUNCATE', 'DELETE FROM', 'pg_restore', 'UPDATE ', 'INSERT ']) {
      expect(backup).not.toContain(forbidden);
    }
  });

  it('restore.sh does not restore over production', () => {
    expect(restore).toContain('--network none');
    expect(restore).not.toContain('truevine-postgres');
    expect(restore).not.toContain('truevine-redis');
  });
});

describe('Restore safety model', () => {
  it('defaults to verify-only (no restore unless --restore flag)', () => {
    expect(restore).toMatch(/DO_RESTORE=0/);
    const verifyExit = restore.indexOf('no database was touched');
    const container = restore.indexOf('docker run -d --name "$CONTAINER"');
    expect(verifyExit).toBeGreaterThan(-1);
    expect(container).toBeGreaterThan(-1);
    expect(verifyExit).toBeLessThan(container);
  });

  it('uses a unique restore identity and refuses name collisions', () => {
    expect(restore).toContain('RUN_NONCE=$(od -An -N16 -tx1 /dev/urandom');
    expect(restore).toContain('restore container name already exists; refusing to use or remove it');
    expect(restore).toContain('restore volume name already exists; refusing to use or remove it');
  });

  it('only removes resources after verifying captured identity and isolation', () => {
    expect(restore).toContain('inspected_id" = "$RESTORE_CONTAINER_ID"');
    expect(restore).toContain('inspected_label" = "$RUN_LABEL"');
    expect(restore).toContain('network" = "none"');
    expect(restore).toContain('inspected_mountpoint" = "$RESTORE_VOLUME_MOUNTPOINT"');
    expect(restore).toContain('inspected_created_at" = "$RESTORE_VOLUME_CREATED_AT"');
    expect(restore).toContain('refusing to remove restore container: ownership could not be verified');
    expect(restore).toContain('refusing to remove restore volume: ownership could not be verified');
  });

  it('refuses a key file readable by group or other', () => {
    expect(common).toMatch(/must not be readable by group or other/);
    expect(restore).toMatch(/must not be readable by group or other/);
    expect(restore).toMatch(/8#\$?\w+\s*&\s*8#077/);
  });
});

describe('Backup checksum and integrity verification', () => {
  it('backup.sh records ciphertext and plaintext sha256 in manifest', () => {
    expect(backup).toMatch(/cipher_sha256/);
    expect(backup).toMatch(/"dump_sha256":\s*"\$dump_sha"/);
  });

  it('restore.sh verifies downloaded ciphertext against manifest', () => {
    expect(restore).toMatch(/expected_cipher_sha=\$\(node -e/);
    expect(restore).toContain('verify_sha256 "$cipher" "$expected_cipher_sha"');
  });

  it('restore.sh verifies decrypted plaintext against manifest', () => {
    expect(restore).toMatch(/expected_sha=.*dump_sha256/s);
    expect(restore).toContain('verify_sha256 "$plain" "$expected_sha"');
  });

  it('lib/common.sh provides verify_sha256 and sha256_of', () => {
    expect(common).toContain('verify_sha256');
    expect(common).toContain('sha256_of');
  });

  it('never verifies a file against its own hash (tautology check)', () => {
    const tautology = /verify_sha256\s+"\$\w+"\s+"\$\(sha256_of\s+"\$(\w+)"\)/g;
    for (const [name, source] of [
      ['restore.sh', restore],
      ['backup.sh', backup],
    ] as const) {
      expect(source.match(tautology) ?? [], `${name} compares a file to itself`).toEqual([]);
    }
  });

  it('refuses a manifest that cannot vouch for the object', () => {
    expect(restore).toMatch(/manifest has no cipher_sha256/);
  });
});

describe('Integrity validation: organizations and users', () => {
  it('fingerprint queries organizations row count', () => {
    expect(dbVerify).toMatch(/SELECT 'R\|organizations\|' \|\| count\(\*\) FROM organizations/);
  });

  it('fingerprint queries users row count', () => {
    expect(dbVerify).toMatch(/SELECT 'R\|users\|' \|\| count\(\*\) FROM users/);
  });

  it('fingerprint queries memberships row count', () => {
    expect(dbVerify).toMatch(/SELECT 'R\|memberships\|' \|\| count\(\*\) FROM memberships/);
  });
});

describe('Integrity validation: wallet balances and financial ledger', () => {
  it('fingerprint queries wallet_entries row count', () => {
    expect(dbVerify).toMatch(/SELECT 'R\|wallet_entries\|' \|\| count\(\*\) FROM wallet_entries/);
  });

  it('fingerprint queries top_up_requests row count', () => {
    expect(dbVerify).toMatch(/SELECT 'R\|top_up_requests\|' \|\| count\(\*\) FROM top_up_requests/);
  });

  it('fingerprint queries payment_intents row count', () => {
    expect(dbVerify).toMatch(/SELECT 'R\|payment_intents\|' \|\| count\(\*\) FROM payment_intents/);
  });

  it('wallet balance integrity: wallet_entries reference valid organizations', () => {
    expect(dbVerify).toMatch(
      /SELECT 'TI\|wallet_entries\|' \|\| count\(\*\) FROM wallet_entries w LEFT JOIN organizations o ON w\.organization_id = o\.id WHERE o\.id IS NULL/,
    );
  });

  it('top_up_requests reference valid organizations', () => {
    expect(dbVerify).toMatch(
      /SELECT 'TI\|top_up_requests\|' \|\| count\(\*\) FROM top_up_requests t LEFT JOIN organizations o ON t\.organization_id = o\.id WHERE o\.id IS NULL/,
    );
  });

  it('payment_intents reference valid organizations', () => {
    expect(dbVerify).toMatch(
      /SELECT 'TI\|payment_intents\|' \|\| count\(\*\) FROM payment_intents p LEFT JOIN organizations o ON p\.organization_id = o\.id WHERE o\.id IS NULL/,
    );
  });
});

describe('Integrity validation: campaigns and campaign recipients', () => {
  it('fingerprint queries campaigns row count', () => {
    expect(dbVerify).toMatch(/SELECT 'R\|campaigns\|' \|\| count\(\*\) FROM campaigns/);
  });

  it('fingerprint queries campaign_recipients row count', () => {
    expect(dbVerify).toMatch(/SELECT 'R\|campaign_recipients\|' \|\| count\(\*\) FROM campaign_recipients/);
  });

  it('fingerprint queries campaign_executions row count', () => {
    expect(dbVerify).toMatch(/SELECT 'R\|campaign_executions\|' \|\| count\(\*\) FROM campaign_executions/);
  });

  it('campaigns reference valid organizations', () => {
    expect(dbVerify).toMatch(
      /SELECT 'TI\|campaigns\|' \|\| count\(\*\) FROM campaigns c LEFT JOIN organizations o ON c\.organization_id = o\.id WHERE o\.id IS NULL/,
    );
  });

  it('campaign_recipients reference valid organizations', () => {
    expect(dbVerify).toMatch(
      /SELECT 'TI\|campaign_recipients\|' \|\| count\(\*\) FROM campaign_recipients cr LEFT JOIN organizations o ON cr\.organization_id = o\.id WHERE o\.id IS NULL/,
    );
  });

  it('campaign_executions reference valid campaigns', () => {
    expect(dbVerify).toMatch(
      /SELECT 'TI\|campaign_executions\|' \|\| count\(\*\) FROM campaign_executions ce LEFT JOIN campaigns c ON ce\.organization_id = c\.organization_id AND ce\.campaign_id = c\.id WHERE c\.id IS NULL/,
    );
  });
});

describe('Integrity validation: call attempts and SMS fallback', () => {
  it('fingerprint queries call_attempts row count', () => {
    expect(dbVerify).toMatch(/SELECT 'R\|call_attempts\|' \|\| count\(\*\) FROM call_attempts/);
  });

  it('fingerprint queries sms_fallback_operations row count', () => {
    expect(dbVerify).toMatch(/SELECT 'R\|sms_fallback_operations\|' \|\| count\(\*\) FROM sms_fallback_operations/);
  });

  it('call_attempts reference valid organizations', () => {
    expect(dbVerify).toMatch(
      /SELECT 'TI\|call_attempts\|' \|\| count\(\*\) FROM call_attempts ca LEFT JOIN organizations o ON ca\.organization_id = o\.id WHERE o\.id IS NULL/,
    );
  });

  it('sms_fallback_operations reference valid organizations', () => {
    expect(dbVerify).toMatch(
      /SELECT 'TI\|sms_fallback_operations\|' \|\| count\(\*\) FROM sms_fallback_operations s LEFT JOIN organizations o ON s\.organization_id = o\.id WHERE o\.id IS NULL/,
    );
  });

  it('contacts reference valid organizations', () => {
    expect(dbVerify).toMatch(
      /SELECT 'TI\|contacts\|' \|\| count\(\*\) FROM contacts c LEFT JOIN organizations o ON c\.organization_id = o\.id WHERE o\.id IS NULL/,
    );
  });
});

describe('Integrity validation: database relationships', () => {
  it('fingerprint lists foreign key constraints', () => {
    expect(dbVerify).toMatch(/SELECT 'FK\|' \|\| conname \|\| '\|' \|\| conrelid::regclass::text \|\| '\|' \|\| pg_get_constraintdef\(oid\)/);
  });

  it('fingerprint filters foreign keys to public schema', () => {
    expect(dbVerify).toMatch(/connamespace = 'public'::regnamespace AND contype = 'f'/);
  });
});

describe('Schema and migration compatibility', () => {
  it('fingerprint captures table definitions', () => {
    expect(dbVerify).toMatch(/SELECT 'T\|' \|\| table_name FROM information_schema\.tables/);
  });

  it('fingerprint captures column definitions', () => {
    expect(dbVerify).toMatch(/SELECT 'C\|' \|\| table_name \|\| '.' \|\| column_name/);
  });

  it('fingerprint captures indexes', () => {
    expect(dbVerify).toMatch(/SELECT 'I\|' \|\| indexname FROM pg_indexes/);
  });

  it('fingerprint captures constraints', () => {
    expect(dbVerify).toMatch(/SELECT 'K\|' \|\| conrelid::regclass::text/);
  });

  it('fingerprint captures enum types', () => {
    expect(dbVerify).toMatch(/SELECT 'E\|' \|\| t\.typname FROM pg_type t/);
  });

  it('fingerprint captures migration history', () => {
    expect(dbVerify).toMatch(/SELECT 'M\|' \|\| migration_name/);
  });

  it('fingerprint captures server version and data directory', () => {
    expect(dbVerify).toMatch(/SELECT 'S\|server_major\|' \|\| current_setting\('server_version_num'\)::int \/ 10000/);
    expect(dbVerify).toMatch(/SELECT 'S\|data_directory\|' \|\| current_setting\('data_directory'\)/);
  });
});

describe('Restore duration measurement', () => {
  it('db-verify.sh measures and reports restore duration', () => {
    expect(dbVerify).toMatch(/restore_start=\$\(date \+%s\)/);
    expect(dbVerify).toMatch(/restore_end=\$\(date \+%s\)/);
    expect(dbVerify).toMatch(/restore_seconds=\$\(\(restore_end - restore_start\)\)/);
    expect(dbVerify).toMatch(/pass "pg_restore completed with no errors in \$\{restore_seconds\}s"/);
    expect(dbVerify).toMatch(/info "restore duration: \$\{restore_seconds\}s"/);
  });

  it('restore duration is measured around pg_restore only', () => {
    // restore_start must be set before restore_into, restore_end after
    const startIdx = dbVerify.indexOf('restore_start=$(date +%s)');
    const restoreIntoIdx = dbVerify.indexOf('restore_into "$cname" "$backup"');
    const endIdx = dbVerify.indexOf('restore_end=$(date +%s)');
    expect(startIdx).toBeGreaterThan(-1);
    expect(restoreIntoIdx).toBeGreaterThan(startIdx);
    expect(endIdx).toBeGreaterThan(restoreIntoIdx);
  });
});

describe('Exit codes and status', () => {
  it('common.sh defines distinct exit codes', () => {
    const codes = [...common.matchAll(/readonly EXIT_(\w+)=(\d+)/g)].map((m) => [m[1], Number(m[2])]);
    expect(codes.length).toBeGreaterThanOrEqual(4);
    expect(new Set(codes.map(([, v]) => v)).size).toBe(codes.length);
  });

  it('common.sh defines EXIT_VERIFY=6', () => {
    expect(common).toContain('readonly EXIT_VERIFY=6');
  });

  it('restore.sh uses EXIT_VERIFY for integrity failures', () => {
    expect(restore).toContain('EXIT_VERIFY');
  });
});

describe('No production database access', () => {
  it('db-verify.sh never writes to production', () => {
    // verify-restore uses --no-owner --no-privileges into an isolated container
    expect(dbVerify).toContain('--no-owner --no-privileges');
    // It captures production identity but never mutates it
    expect(dbVerify).toContain('capture_production_identity');
    expect(dbVerify).toContain('assert_not_production');
  });

  it('restore.sh uses --network none for isolation', () => {
    expect(restore).toContain('--network none');
  });

  it('restore.sh never references production container names', () => {
    expect(restore).not.toContain('truevine-postgres');
    expect(restore).not.toContain('truevine-redis');
  });
});

describe('Staging hygiene and cleanup', () => {
  it('db-verify.sh installs EXIT trap for cleanup', () => {
    expect(dbVerify).toMatch(/trap on_exit EXIT/);
  });

  it('cleanup only removes resources carrying this run label', () => {
    expect(dbVerify).toContain('LABEL_KEY="truevine.verify.run"');
    expect(dbVerify).toContain('filter "label=${LABEL_KEY}"');
    expect(dbVerify).toContain('backups in ${BACKUP_DIR} are never touched by cleanup');
  });
});
