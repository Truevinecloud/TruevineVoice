import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Static assertions over the backup scripts.
//
// The runtime suite (infrastructure/backup/backup.test.sh) is the real proof:
// it executes backup.sh and restore.sh against a live PostgreSQL instance. It
// needs bash, `age` and a container runtime, so it cannot run on a Windows
// workstation or in a fast unit-test job.
//
// These assertions are the cheap, always-on half. They do not execute anything;
// they pin the properties that must not regress silently, and they run
// everywhere the Vitest suite runs.
const here = dirname(fileURLToPath(import.meta.url));
const read = (name: string): string => readFileSync(resolve(here, '..', 'backup', name), 'utf8');

const common = read('lib/common.sh');
const backup = read('backup.sh');
const restore = read('restore.sh');

/** All lines in `source` that contain `needle`. */
const linesWith = (source: string, needle: string): string[] =>
  source.split('\n').filter((line) => line.includes(needle));

describe('backup encryption', () => {
  it('encrypts before any upload, never after', () => {
    const encryptAt = backup.indexOf('encrypt_stream');
    const firstPut = backup.indexOf('store_put');
    expect(encryptAt).toBeGreaterThan(-1);
    expect(firstPut).toBeGreaterThan(-1);
    expect(encryptAt).toBeLessThan(firstPut);
  });

  it('encrypts both the database dump and the configuration archive', () => {
    // One call for the dump, one for the config tarball. If either is dropped,
    // something reaches the bucket in the clear.
    expect(linesWith(backup, 'encrypt_stream')).toHaveLength(2);
  });

  it('removes the plaintext dump once it is encrypted', () => {
    expect(backup).toMatch(/encrypt_stream "\$cipher" < "\$dump"[\s\S]*?rm -f "\$dump"/);
  });

  it('removes the plaintext configuration archive once it is encrypted', () => {
    expect(backup).toMatch(/encrypt_stream "\$cipher" < "\$archive"[\s\S]*?rm -f "\$archive"/);
  });

  it('never hands a plaintext dump or archive to the storage backend', () => {
    for (const call of linesWith(backup, 'store_put')) {
      expect(call).not.toMatch(/\$dump\b/);
      expect(call).not.toMatch(/\$archive\b/);
    }
  });
});

describe('backup secrets handling', () => {
  it('never bundles .env', () => {
    // Allow-listed files, not mentions in comments.
    const allowed = backup.match(/for rel in ([^;]+);/)?.[1] ?? '';
    expect(allowed).not.toMatch(/\.env\b/);
  });

  it('refuses to upload a bundle containing a credential', () => {
    expect(common).toContain('assert_no_secrets');
    expect(common).toMatch(/refusing to upload/);
  });

  it('detects credentials in both dotenv and YAML/JSON assignment forms', () => {
    // Each of these three details caused a real defect before it was handled:
    //   [=:]        dotenv "KEY=value" and YAML "KEY: value"
    //   [[:space:]]*  YAML puts a space after the colon
    //   ["']?       JSON keys are quoted, so "PROVIDER_SECRET_KEY": "sk-..."
    // Pinning them so they cannot regress.
    expect(common).toContain('[=:]');
    expect(common).toContain('[[:space:]]*');
    expect(common).toContain('["\']?');
  });

  it('redacts key material and connection strings from every log line', () => {
    expect(common).toMatch(/AGE-SECRET-KEY-1/);
    // The DSN rule must survive the optional `ql`: a postgresql:// URL with a
    // password is the highest-value thing to keep out of a log.
    expect(common).toContain('postgres(ql)?');
    expect(common).toMatch(/<redacted>/);
    // The redactor must be applied inside the logging function itself, so a
    // future `echo` elsewhere cannot bypass it.
    const logFn = common.match(/_log\(\)[\s\S]*?\n}/)?.[0] ?? '';
    expect(logFn).toContain('redact');
  });
});

describe('restore safety model', () => {
  it('defaults to verify-only and never restores unless asked', () => {
    expect(restore).toMatch(/DO_RESTORE=0/);
    // The verify-only path must exit before any container is created.
    const verifyExit = restore.indexOf('no database was touched');
    const container = restore.indexOf('docker run -d --name "$CONTAINER"');
    expect(verifyExit).toBeGreaterThan(-1);
    expect(container).toBeGreaterThan(-1);
    expect(verifyExit).toBeLessThan(container);
  });

  it('restores only into a labelled, network-isolated throwaway instance', () => {
    expect(restore).toContain('--network none');
    expect(restore).toMatch(/--label "truevine\.verify\.run=\$RUN_LABEL"/);
  });

  it('never references the production database container', () => {
    expect(restore).not.toContain('truevine-postgres');
  });

  it('never deletes a backup from the store', () => {
    // Retention is enforced by bucket lifecycle rules, not by the script.
    // A script that deletes cannot be reasoned about after the fact.
    expect(common + backup + restore).not.toMatch(/\brm -rf?\s+"?s3:/);
    expect(common).not.toContain('delete-object');
    expect(common).not.toContain('s3 rm');
  });

  it('verifies the decrypted plaintext against the sha256 recorded at backup time', () => {
    expect(restore).toMatch(/expected_sha=.*dump_sha256/s);
    expect(restore).toContain('verify_sha256 "$plain" "$expected_sha"');
  });

  it('refuses a key file readable by group or other', () => {
    for (const source of [common, restore]) {
      expect(source).toMatch(/must not be readable by group or other/);
      // `8#` base prefix: bash arithmetic rejects a C-style `0o` octal prefix,
      // which silently turned this check into an error instead of a comparison.
      expect(source).toMatch(/8#\$?\w+\s*&\s*8#077/);
    }
  });
});

describe('backup preconditions', () => {
  it('exits with a precondition failure code before writing anything', () => {
    expect(common).toContain('EXIT_PRECONDITION');
    expect(common).toMatch(/BACKUP_KEYFILE is not set/);
  });

  it('validates the storage backend choice', () => {
    expect(common).toMatch(/BACKUP_STORE must be 's3' or 'local'/);
  });

  it('uses distinct exit codes so monitoring can tell failures apart', () => {
    const codes = [...common.matchAll(/readonly EXIT_(\w+)=(\d+)/g)].map((m) => [
      m[1],
      Number(m[2]),
    ]);
    expect(codes.length).toBeGreaterThanOrEqual(7);
    expect(new Set(codes.map(([, v]) => v)).size).toBe(codes.length);
  });
});

describe('backup retention policy', () => {
  it('keeps 7 daily, 4 weekly and 3 monthly backups', () => {
    expect(common).toMatch(/KEEP_DAILY=7/);
    expect(common).toMatch(/KEEP_WEEKLY=4/);
    expect(common).toMatch(/KEEP_MONTHLY=3/);
  });
});

describe('backup write scope', () => {
  it('only reads the database, and never migrates or drops anything', () => {
    // backup.sh must not contain any statement that could mutate or destroy
    // data. pg_dump -Fc is a read.
    expect(backup).toContain('pg_dump');
    for (const forbidden of ['DROP ', 'DROP TABLE', 'TRUNCATE', 'DELETE FROM', 'pg_restore']) {
      expect(backup).not.toContain(forbidden);
    }
  });

  it('refuses to continue when the dump is not a real archive', () => {
    expect(backup).toMatch(/PGDMP/);
    expect(backup).toMatch(/pg_dump failed; no partial file left behind/);
  });
});

describe('staging hygiene', () => {
  it('installs an EXIT trap in both scripts', () => {
    // Staging holds ciphertext and, during a restore, the decrypted production
    // dump. Without a trap it survives the run and sits in /tmp.
    for (const [name, source] of [
      ['backup.sh', backup],
      ['restore.sh', restore],
    ] as const) {
      expect(source, `${name} has no EXIT trap`).toMatch(/trap\s+\w+\s+EXIT/);
    }
  });

  it('registers exactly one EXIT trap per script', () => {
    // bash keeps only the last trap set for a signal, so two `trap ... EXIT`
    // lines silently disable the first. That is how a cleanup handler is lost.
    for (const [name, source] of [
      ['backup.sh', backup],
      ['restore.sh', restore],
    ] as const) {
      const traps = [...source.matchAll(/trap\s+\S+\s+EXIT/g)];
      expect(traps.length, `${name} registers ${traps.length} EXIT traps`).toBe(1);
    }
  });

  it('removes the decrypted dump from every restore exit path', () => {
    expect(common).toContain('scrub_plaintext');
    const scrubs = restore.match(/scrub_plaintext "\$plain"/g) ?? [];
    expect(scrubs.length).toBeGreaterThanOrEqual(3);
  });

  it('only deletes a staging directory it created itself', () => {
    expect(common).toContain('BACKUP_WORK_DIR_OWNED');
    expect(common).toMatch(/release_work_dir\(\)/);
  });
});

describe('machine-readable status', () => {
  it('writes status where monitoring reads it, not into a temp directory', () => {
    // Written unconditionally into the staging dir, the status file was read by
    // nobody and looked like a monitoring channel that did not exist.
    expect(backup).toMatch(/BACKUP_STATUS_FILE:-\$BACKUP_WORK_DIR/);
  });

  it('records a failure state as well as success', () => {
    expect(backup).toMatch(/write_status .* failed "\$rc"/);
    expect(backup).toContain('exit_code');
  });
});

describe('captured object metadata', () => {
  it('emits structured JSON rather than delimited strings', () => {
    expect(backup).toContain('image: i.Config.Image');
    expect(backup).not.toMatch(/\{\.Name\}\|\{/);
  });

  it('validates the inventory it wrote', () => {
    expect(backup).toMatch(/JSON\.parse\(require\("fs"\)\.readFileSync\(process\.argv\[1\]/);
  });
});

describe('integrity verification is real', () => {
  it('records a hash of the ciphertext it uploaded', () => {
    // Without this the restore has nothing to check the object against, and
    // "verification" collapses into comparing a file to itself.
    expect(backup).toMatch(/cipher_sha256/);
    expect(backup).toMatch(/"dump_sha256":\s*"\$dump_sha"/);
  });

  it('never verifies a file against its own hash', () => {
    // Guards the tautology that was in restore.sh:
    //   verify_sha256 "$cipher" "$(sha256_of "$cipher")"
    // It can never fail, so it logged a reassuring "verified" for an object it
    // had in fact checked nothing about.
    const tautology = /verify_sha256\s+"\$\w+"\s+"\$\(sha256_of\s+"\$(\w+)"\)/g;
    for (const [name, source] of [
      ['restore.sh', restore],
      ['backup.sh', backup],
    ] as const) {
      expect(source.match(tautology) ?? [], `${name} compares a file to itself`).toEqual([]);
    }
  });

  it('checks the downloaded ciphertext against the manifest', () => {
    expect(restore).toMatch(/expected_cipher_sha=\$\(node -e/);
    expect(restore).toContain('verify_sha256 "$cipher" "$expected_cipher_sha"');
  });

  it('still checks the decrypted plaintext against the manifest', () => {
    expect(restore).toMatch(/expected_sha=.*dump_sha256/s);
    expect(restore).toContain('verify_sha256 "$plain" "$expected_sha"');
  });

  it('refuses a manifest that cannot vouch for the object', () => {
    expect(restore).toMatch(/manifest has no cipher_sha256/);
  });
});
