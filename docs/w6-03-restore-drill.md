# W6-03 Backup Restore Drill

**Task ID:** W6-03
**Week:** 6
**Epic:** Recovery
**Priority:** P0
**Owner/Lane:** DevOps/QA
**Dependency:** W1-10 (Design low-cost backup path)
**Status:** In Progress — implementation complete, production acceptance pending
**Acceptance:** Restore evidence + measured time
**Target environment:** Isolated
**Specification reference:** §31 (unavailable)

---

## 1. Current Infrastructure Inventory

### Deployment target

| Item | Value | Source |
|------|-------|--------|
| Provider | Contabo VPS | README.md — Production deployment |
| OS | Ubuntu 24.04 | README.md — Production runbook |
| Container runtime | Docker | docker-compose.yml |
| Node.js | 24.19.0 (LTS) | README.md — Requirements |
| npm | 11.17.0 | README.md — Requirements |
| Deployment tool | PM2 | README.md — Production deployment |
| CI pipeline | GitHub Actions (4 parallel jobs) | README.md — Continuous integration |

### Infrastructure components (docker-compose.yml)

| Component | Image | Host port | Container port | Notes |
|-----------|-------|-----------|----------------|-------|
| PostgreSQL | postgres:18-alpine | 55432 | 5432 | Loopback only (127.0.0.1) |
| Redis | redis:8-alpine | 56379 | 6379 | Loopback only (127.0.0.1) |

### Application processes (run on host, not containers)

| Process | Port | Technology | Binding |
|---------|------|------------|---------|
| API | 3001 | NestJS 12 | 0.0.0.0 |
| Web | 3000 | Next.js 16 | — |
| Admin | 3002 | Next.js 16 | — |
| Worker | — | NestJS 12 | — |

### VPS configuration

**NOT DOCUMENTED.** The following are NOT in the repository and must not be invented:
- Contabo VPS plan/specs (CPU cores, RAM, disk size)
- Monthly cost
- Current resource utilization
- Disk growth rate
- Network traffic volume

These must be measured on the actual VPS before thresholds can be validated.

---

## 2. W1-10 Backup Implementation Status

W1-10 (Design low-cost backup path) is **In Progress**. The following backup infrastructure exists and is unit-tested:

| Component | File | Purpose |
|-----------|------|---------|
| Encrypted backup | `infrastructure/scripts/backup.sh` | Encrypted PostgreSQL custom-format backup with SHA256 checksums |
| Encrypted restore | `infrastructure/scripts/restore.sh` | Restore into isolated Docker instance with manifest integrity verification |
| Shared library | `infrastructure/backup/lib/common.sh` | Encryption, checksums, secret gate, storage, retention helpers |
| Static assertions | `infrastructure/backup/backup.spec.ts` | 363-line Vitest spec covering encryption, secrets, restore safety, integrity, retention, staging hygiene, status file, metadata |
| Runtime tests | `infrastructure/backup/backup.test.sh` | 15-section POSIX/Linux runtime test suite |
| PostgreSQL restore verification | `infrastructure/scripts/db-verify.sh` | Restore verification with fingerprint validation |
| DB-verify runtime tests | `infrastructure/scripts/db-verify.runtime.sh` | Runtime tests for db-verify (stub-based) |
| Backup freshness monitoring | `infrastructure/scripts/monitor-backup.sh` | Backup status file freshness check |

### Backup safety model

- **Identity-based protection:** Every resource carries `truevine.verify.run=<run id>` label. Nothing is destroyed unless it carries this run's label.
- **Production identity capture:** Container IDs and volume mountpoints are captured at start-up; renamed production resources are still refused.
- **Ownership assertion:** Verified immediately before each destructive command; fails closed if identity cannot be established.
- **Cleanup:** Only removes resources labelled with this run's ID; backups are never removed.
- **Read-only production access:** The script only reads production datastores; it never stops, restarts, recreates or modifies production containers, volumes or data.

---

## 3. W6-03 Restore Drill Implementation

### Integrity validation coverage

The `db-verify.sh` fingerprint validation now covers:

| Category | Tables | Validation |
|----------|--------|------------|
| Organizations and users | `organizations`, `users`, `memberships` | Row counts |
| Wallet balances | `wallet_entries` | Row count + tenant isolation (organization_id references organizations) |
| Financial ledger | `top_up_requests`, `payment_intents` | Row counts + tenant isolation |
| Campaign records | `campaigns`, `campaign_executions` | Row counts + tenant isolation |
| Campaign recipients | `campaign_recipients` | Row count + tenant isolation |
| Call attempts | `call_attempts` | Row count + tenant isolation |
| SMS fallback | `sms_fallback_operations` | Row count + tenant isolation |
| Contacts | `contacts` | Row count + tenant isolation |
| Database relationships | All foreign keys | Constraint listing via pg_constraint |
| Schema compatibility | Tables, columns, indexes, constraints, enums | Information schema capture |
| Migration compatibility | `_prisma_migrations` | Migration names, timestamps, step counts |
| Server identity | `server_version_num`, `data_directory` | Version and data directory capture |

### Tenant isolation validation

Every tenant-owned table is validated against the `organizations` table:

```sql
SELECT 'TI|wallet_entries|' || count(*) FROM wallet_entries w LEFT JOIN organizations o ON w.organization_id = o.id WHERE o.id IS NULL;
```

A non-zero count is a finding (orphaned row without a valid organization). All zero results indicate clean tenant isolation.

### Restore duration measurement

The `verify-restore` subcommand measures total restore duration:

```bash
restore_start=$(date +%s)
restore_into "$cname" "$backup" || exit 1
restore_end=$(date +%s)
restore_seconds=$((restore_end - restore_start))
pass "pg_restore completed with no errors in ${restore_seconds}s"
info "restore duration: ${restore_seconds}s"
```

This measures only the `pg_restore` phase, not container startup or fingerprint computation.

### Backup checksum and integrity verification

- **`backup.sh`** records `cipher_sha256` and `dump_sha256` in the manifest JSON
- **`restore.sh`** verifies downloaded ciphertext against the manifest cipher_sha256, then verifies decrypted plaintext against manifest dump_sha256
- **Never verifies against its own hash:** The plaintext hash comes from the manifest, not from re-hashing the decrypted file
- **Manifest mismatch:** A manifest whose `cipher_sha256` doesn't match the stored object is rejected with exit code 6

---

## 4. Restore Drill Procedure

### Prerequisites

1. Docker Desktop running with `postgres:18-alpine` and `redis:8-alpine` images available locally
2. Production PostgreSQL container (`truevine-postgres`) running and accessible
3. `backup.sh`, `restore.sh`, `db-verify.sh` scripts present and executable
4. `age-keygen` available for encryption key generation (for backup creation)
5. `pg_restore` available locally or in the production container

### Drill execution steps

#### Step 1: Pre-flight verification

```bash
./infrastructure/scripts/db-verify.sh preflight
```

Verifies:
- Docker is installed
- Required images are present locally
- Production containers are running
- Production identity is captured

#### Step 2: Create a backup

```bash
./infrastructure/scripts/db-verify.sh backup
```

Creates:
- A custom-format PostgreSQL backup (`PGDMP`)
- SHA256 checksum file (`.sha256`)
- Backup metadata in status file

#### Step 3: Verify restore into isolated instance

```bash
./infrastructure/scripts/db-verify.sh verify-restore <backup.dump>
```

Performs:
1. Creates a temporary Docker volume and PostgreSQL container (label-scoped)
2. Restores the backup into the isolated container
3. Measures restore duration
4. Asserts the restored schema contains at least as many tables as the archive declared
5. Runs fingerprint validation against the restored database
6. Cleans up all temporary resources (label-scoped)

#### Step 4: Verify volume persistence

```bash
./infrastructure/scripts/db-verify.sh verify-volume <backup.dump>
```

Performs:
1. Restores into container A on a dedicated volume
2. Fingerprints the restored state
3. Removes container A, retains the volume
4. Creates container B on the same volume
5. Compares fingerprints before and after recreation
6. Cleans up all temporary resources

#### Step 5: Verify Redis persistence (optional)

```bash
./infrastructure/scripts/db-verify.sh verify-redis
```

Performs:
1. Creates a temporary Redis container with append-only persistence
2. Writes a synthetic key and persists it with BGSAVE
3. Recreates the container against the same volume
4. Verifies the key survived container recreation
5. Cleans up all temporary resources

#### Step 6: Cleanup

```bash
./infrastructure/scripts/db-verify.sh cleanup
```

Removes all resources created by this run (label-scoped). Backups are never touched.

### Success criteria

| Check | Expected result |
|-------|-----------------|
| Preflight | All prerequisites pass |
| Backup creation | Non-zero byte PGDMP archive with SHA256 checksum |
| Verify-restore | Restore completes in N seconds; zero fingerprint mismatches |
| Verify-volume | Fingerprints identical before and after container recreation |
| Verify-redis | Key survives container recreation; byte-for-byte identical value |
| Cleanup | No containers or volumes remain from this run |
| Production unchanged | All production containers report same state as before |

---

## 5. Deterministic Automated Tests

**File:** `infrastructure/scripts/restore-drill.spec.ts`

54 deterministic tests covering:

| Test group | Count | What is verified |
|------------|-------|------------------|
| W1-10 backup readiness | 5 | Scripts exist, contain expected patterns, no DDL/DML in backup |
| Restore safety model | 4 | Verify-only default, isolated instance, network isolation, key file permissions |
| Backup checksum and integrity | 5 | Ciphertext/plaintext SHA256 verification, manifest integrity, no tautology checks |
| Organizations and users | 3 | Row counts for organizations, users, memberships |
| Wallet balances and financial ledger | 4 | Row counts + tenant isolation for wallet, top-up requests, payment intents |
| Campaigns and campaign recipients | 4 | Row counts + tenant isolation for campaigns, recipients, executions |
| Call attempts and SMS fallback | 3 | Row counts + tenant isolation for call attempts, SMS fallback, contacts |
| Database relationships | 2 | Foreign key constraint listing, public schema filter |
| Schema and migration compatibility | 6 | Tables, columns, indexes, constraints, enums, migrations, server version |
| Restore duration measurement | 2 | Duration measured around pg_restore, start/end ordering |
| Exit codes and status | 3 | Distinct exit codes in common.sh, EXIT_VERIFY=6, restore.sh uses EXIT_VERIFY |
| No production database access | 3 | --no-owner --no-privileges, --network none, no production container names |
| Staging hygiene and cleanup | 3 | EXIT trap, label-scoped cleanup, backups never touched |

**Test approach:** All tests are static assertions against script text. No Docker, no PostgreSQL, no production access required. Tests run on any workstation with Node.js and Vitest.

---

## 6. Capacity Planning Decision Matrix

| Condition | CPU load | CPU util | Memory available | Disk free | Network | Queue | Action |
|-----------|----------|----------|------------------|-----------|---------|-------|--------|
| All below warning | <70% cores | <75% | >20% | >20% free | <50% link | <50 waiting | Monitor only |
| One metric at warning | 70-90% cores | 75-90% | 10-20% | 10-20% free | 50-80% link | 50-100 waiting | Investigate, optimize |
| One metric at critical | >90% cores | >90% | <10% | <10% free | >80% link | >100 waiting | Investigate, upgrade candidate |
| Multiple metrics at critical | Multiple >90% | Multiple >90% | Multiple <10% | Multiple <10% | Multiple saturated | Multiple backed up | Investigate, prepare upgrade proposal |

---

## 7. Outstanding Production Verification Requirements

| Requirement | Status | Notes |
|-------------|--------|-------|
| VPS resource specs (CPU, RAM, disk) | Not available | Must be measured on actual VPS |
| Production cost figures | Not available | Must not be invented |
| Baseline measurements | Not available | Requires W6-02 deployed to VPS |
| Threshold validation | Not available | Proposals only until approved |
| Upgrade decision procedure | Not available | Requires owner approval |
| Shared package typecheck | PASS | `tsc --noEmit -p packages/shared/tsconfig.json` |
| Shared package tests | PASS | 93 tests passing |
| Shared package build | PASS | `npm run build --workspace @truevine/shared` |
| Restore drill tests | PASS | 54 tests passing |
| ESLint verification | Not complete | ESLint hangs in current environment |
| API-wide typecheck | Unresolved | Exit code 2 in `correlation-id.middleware.spec.ts` (pre-existing, not W6-03 ownership) |

---

## 8. Files Created and Modified

### Created

| File | Purpose |
|------|---------|
| `infrastructure/scripts/restore-drill.spec.ts` | 54 deterministic Vitest tests for restore drill tooling |
| `docs/w6-03-restore-drill.md` | This document |

### Modified

| File | Change |
|------|--------|
| `infrastructure/scripts/db-verify.sh` | Extended fingerprint SQL with 14 additional row counts, 9 tenant isolation checks, foreign key constraint listing; added restore duration measurement |

### Build artifact

| Artifact | Status |
|----------|--------|
| None | No TypeScript changes; no build required |

---

## 9. Testing Handoff Readiness

### Ready for testing agent

The restore drill tooling is implemented and tested. The testing agent should:

1. Run `npx vitest run infrastructure/scripts/restore-drill.spec.ts` — 54 tests, all pass
2. Run `npx vitest run infrastructure/scripts/` — all infrastructure spec tests
3. Run `npx tsc --noEmit -p packages/shared/tsconfig.json` — typecheck passes
4. Run `npm run build --workspace @truevine/shared` — build passes
5. Execute the restore drill procedure against a real PostgreSQL instance (requires Docker)
6. Measure actual restore duration on production-sized backups
7. Validate integrity checks against real production data

### Remaining limitations

- Docker not available in this workstation environment; runtime tests cannot execute
- No production-sized backup available for timing calibration
- ESLint hangs in this environment; cannot complete lint verification
- Spec §31 is unavailable; task acceptance based on workplan only

---

## 10. Recommended Workplan Status

**W6-03: In Progress** — Implementation complete, production acceptance pending.

**Do not mark W6-03 Complete until** genuine live restore evidence and measured restore time are documented.

---

## 11. Next Eligible Independent Development Task

After W6-03 handoff, the next eligible task depends on workplan status. Candidates include W7-01 (Pilot onboarding) or other P1/P2 items. The owner should confirm which task to proceed with next.
