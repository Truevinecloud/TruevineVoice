# PR #42 call persistence migration - release approval record

Status: release owner authorized; protected CI and normal merge/deployment gates remain mandatory.
Canonical workplan task ID: UNVERIFIED.

This change proposes adding only 20261021120000_call_persistence to the
production migration manifest. All thirteen existing entries are retained.
Implementation remains in PR #42 at 1dbde7975d5e920707bc00a035aa57e2e378087d.
This approval proposal is based on that implementation so CI tests the combined
release. The release owner has now supplied the confirmations recorded below.
No production operation is performed by opening or updating this PR.

## Administrator-reported recovery evidence

Server: vmi3644538. Archive:

- Path: /var/backups/truevinevoice/truevine_voice_20261021T112843Z.dump
- Timestamp: 2026-10-21 11:28:43 UTC
- Size: 58,414 bytes
- SHA-256: 307b2c0cb5bbbd30ebd286f5a02417f7fdd0db00c773ea13f707dc22738261a6
- PostgreSQL: 18.6, postgres:18-alpine
- Catalog: 128 entries; restored public tables: 16; applied migrations: 13
- Checksum / isolated pg_restore / volume persistence: PASS
- Restored schema fingerprint: 336 entries
- Before/after volume-recreation fingerprints: identical
- Temporary resource cleanup: PASS
- Production PostgreSQL and Redis unchanged: YES
- Both verification commands: RESULT: PASS

These are administrator-attested results, not an archive independently read by
the deployment account. No archive, key, password or database contents is
published. No off-site storage, scheduling, encryption development or other
backup infrastructure is included.

## Independently verified production ledger

The existing authenticated truevine-deploy session ran the documented read-only
Prisma migration status command: thirteen migrations, database up to date.
A separate read-only query confirmed:

- All thirteen applied migration checksums match the candidate's canonical Git blobs.
- No unfinished or failed unrolled-back migration record.
- The only pending candidate migration is 20261021120000_call_persistence.
- None of the six new call-persistence tables exists in production.

No production migration, ledger resolution or data update was performed.

## Exact SQL review

Canonical Git-blob SHA-256:
f9734b61e0c2047e9fef108c9af6c06eeafb1877ed9b2ce71447857e946de149

SQL is unchanged from the fully tested PR #42 implementation:
six new tables, one enum, tenant-leading keys, composite parent foreign keys,
E.164/redial checks and immutable history/state guards in BEGIN/COMMIT.
No DROP, backfill, existing-row rewrite, existing-column modification or
existing-table trigger installation occurs.

Foreign keys reference existing organizations/campaigns and acquire locks.
The existing protected executor sets lock_timeout=5s for each lock wait; this
does not bound total migration or lock-holding duration. Its migration command
timeout is thirty minutes. Do not kill unrelated sessions to force progress.
Inspect production activity and stop on unexpected blocking or schema drift.

The running da2e877 release does not query the new tables. The migration is an
expand compatible with that baseline. If migration execution fails, do not
activate the candidate; inspect the ledger/schema before any retry. BEGIN/COMMIT
makes this migration's DDL transactional but is not an automatic Prisma-ledger
repair policy. Never edit applied SQL or reset production.

Application rollback retains the additive schema. There is no automatic down
migration. Dropping populated recipients, attempts or call-event history is not
an approved rollback; use a reviewed forward correction. Any database restore
over production requires separate supervised approval.

## Release-owner confirmations and authorization

On 2026-10-21 the release owner responded PASS to the specific request confirming
that the archive matched a reference from the same production snapshot and that
the 11:28 UTC backup was acceptable for this release. This resolves the previously
listed source/archive-fidelity and recovery-point acceptance gaps.

These confirmations remain administrator/release-owner attestations; the
deployment account did not read the protected backup. The owner has explicitly
and repeatedly authorized deployment after reviewing the published approval
proposal and its schema-retaining rollback limitations. No further deployment
permission is inferred from CI alone.

All nine checks passed on approval candidate c9d7f11953858d801acd1905c8805e6a69d32174:
https://github.com/Truevinecloud/TruevineVoice/actions/runs/39595034951.
This confirmation-record update requires a fresh CI run before normal merge.
After the final approval merge, successful exact-main push CI is still required
before the existing manual production workflow may run.

## Release sequence after all gates pass

Review/merge PR #42 through normal protections. Retarget this approval proposal
if necessary so its final diff is the manifest entry plus this record. Obtain
required passing CI and human review for the approval change. Merge through the
protected policy, then require successful push CI for the exact current main SHA.

Dispatch existing deploy.yml with authorize_production=true, retaining all
current-main, CI, environment and migration gates. No SSH migration command.
Verify workflow success, exact public health version, PostgreSQL/Redis health,
read-only migration status, fourteen successful ledger rows, the new migration's
exact checksum, and the six new tables. Do not place calls or charge wallets.

## Verification record

PR #42's full CI already passed, including thirteen new database contracts on
ordinary and security-isolated PostgreSQL. The manifest proposal requires its
own complete CI run; results will be reported with its PR checks.
Only deployment-approval JSON and this document differ from PR #42.
Original RBAC-004 worktree is preserved; no stash/reset/checkout/rebase there.
