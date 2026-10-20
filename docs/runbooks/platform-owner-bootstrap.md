# First Platform Owner bootstrap — protected operator procedure

Status: implemented locally for review. **No production account creation or
migration execution is approved.** This runbook is a future operator procedure,
not an instruction to execute it during development or deployment.

## Prerequisites and separate authorization

1. Review the implementation, ADR 0014, new migration SQL, automated results
   and protected activation handoff on isolated Linux staging. Review the
   bootstrap claim's irreversible lifecycle and lost/expired activation recovery.
2. Separately approve the schema change with expand/contract and backup/restore
   evidence. The migration is deliberately absent from the deployment approval
   manifest. Never edit an applied migration or bypass that gate.
3. Separately approve the reviewed release deployment. Deployment does not run
   bootstrap or grant platform authority.
4. Before production account creation, obtain explicit operator authorization
   naming the exact release, production database inventory, dedicated new
   recipient identity, stable operation UUID, operator and approval reference.
   Confirm no active, pending or historical owner/claim exists using authorized
   read-only tooling. Do not probe credentials or reset an existing user.
5. Verify a private HTTPS activation origin and an existing approved internal
   admin HTTPS access path. Do not expose admin, weaken cookies, alter SSH,
   grant database rights or copy production secrets into staging/CI.

This command is for the first PLATFORM_OWNER only. It cannot create customer
organizations, choose a password, modify an existing identity, recover a revoked
owner or provision Operations Admin in production. Operations Admin UAT remains
a separate staging-only command requiring the activated Platform Owner.

## Protected inputs

An authorized Linux operator prepares an owned 0700 approval directory and a
separate owned 0700 activation directory outside the checkout. Use a private
editor, not terminal output or a shell heredoc containing credentials. Approval
JSON must be an owned regular 0600 file, without symlink or hard-link indirection.
Do not chmod or reuse another operator's directory. Keep activation storage off
shared drives/backups and verify local access controls before executing.

Example approval shape (placeholders only; not executable authorization):

```json
{
  "version": 1,
  "environment": "staging",
  "email": "dedicated-owner@example.invalid",
  "operationId": "<approved-stable-uuid>",
  "approvalReference": "BOOTSTRAP-REQUEST-123",
  "operatorReference": "OPERATOR-APPROVED-ALIAS",
  "expiresAt": "<future-UTC-ISO-time-within-24-hours>",
  "database": {
    "hostname": "<verified-staging-database-host>",
    "port": "5432",
    "name": "<verified-staging-database-name>"
  },
  "applicationOrigin": "https://<approved-staging-customer-origin>"
}
```

The executing operator independently verifies the external approval; typing a
reference into JSON is not itself authorization. Set DATABASE_URL privately
through the existing approved operator configuration, never a CLI argument,
transcript, CI secret or shared ticket. NODE_ENV must equal the explicitly
selected environment; WEB_PUBLIC_URL must exactly match applicationOrigin.
URL host/port/name must exactly match the approved inventory; no connection
redirection options are accepted. Staging database names must match
`truevine_staging...` or `truevine_uat...` with optional lowercase alphanumeric
underscore-delimited suffixes. Test mode additionally requires a uniquely
named `truevine_bootstrap_test_<16 hex>` loopback database.

Only after the separate staging authorization, the command shape is:

```bash
NODE_ENV=staging PLATFORM_OWNER_BOOTSTRAP_ENABLED=1 npm run bootstrap:platform-owner -- \
  --environment staging \
  --email '<approved-new-identity>' \
  --operation-id '<approved-stable-uuid>' \
  --approval-file '/absolute/private/approval.json' \
  --activation-directory '/absolute/private/activation'
```

Production additionally requires matching production environment/inventory,
`productionAuthorized: true` in the private approval JSON, explicit
`--confirm-production`, and applicationOrigin/WEB_PUBLIC_URL exactly
`https://voice.truevinecloud.online`. These mechanical controls do not replace
the separate production execution authorization described above. Do not change
environment labels or database names to make a refusal go away.

Production approval must also contain `database.systemIdentifier`, a decimal
string independently verified from the intended PostgreSQL cluster using
existing authorized read-only access to `pg_control_system()`. The command
checks this identifier on its own transaction connection before writes. A
matching database name alone is insufficient. If the existing execution role
cannot read that function, stop: do not grant privileges or substitute a guessed
identifier. That access and the approved fingerprint are production prerequisites,
currently unverified. A physical clone can share this identifier; inventory,
trusted connection routing and the external approval remain necessary.

Linux private-file handling requires `/proc/self/fd`. Ancestors must be owned
by root or the executing UID and must not be group/world writable, except for
sticky directories such as `/tmp`. Files are accessed through pinned directory
descriptors; cleanup refuses a replaced inode. Root and other processes sharing
the operator UID remain trusted: these controls cannot isolate their access.

The CLI prints only the stable operation and private artifact path. It never
prints a password, raw activation link, token, connection string or ORM error.
The account has only PLATFORM_OWNER and no organization membership. It has no
usable password until activated. The immutable audit links its subject to the
external approving/executing operator reference; no fictitious DB grantor is
created. On any failure, stop and follow reconciliation below.

## Private activation

After confirming the committed operation/claim, the authorized operator opens
the artifact privately and transfers its single-use link directly to the named
recipient over the approved confidential channel. Do not paste it in chat,
email, tickets, CI output, screenshots or recordings. The recipient sets a
unique password on the verified customer `/set-password` page. The existing
authentication service consumes the token once, expires it after 24 hours,
and commits password change, revocations and audit together. The operator never
chooses or receives the new password. Delete the private artifact after verified
activation using the approved local secure-retirement procedure.

The recipient uses the approved internal HTTPS `/admin` dashboard. Public
customer `/admin` is not an access method. An SSH loopback tunnel alone does
not establish a verified same-origin HTTPS browser login; do not change routes
or cookies to work around missing access. Customer terms are not silently
accepted or invented by this command. No customer billing, call or payment
operation is part of activation.

## Refusal, ambiguous outcome and recovery

- Duplicate email, any existing owner assignment (including revoked), consumed
  claim, expired approval, wrong environment/inventory or unsafe files refuse.
  No existing account or credential is modified. Losing concurrent attempts
  roll back completely. Do not retry using another email or new operation ID.
- Before a known database refusal the private artifact is retired. Unexpected
  transaction/network or shutdown failures may hide a successful COMMIT. The
  command deliberately preserves that protected artifact; its path derives
  from the approved operation ID. An existing artifact is never overwritten.
- Reconcile the immutable claim by operationId and its linked identity/audit
  using existing authorized read-only tooling. Report only IDs/status and
  approval references, never hashes, credentials or links. No reconcile mode
  that queries production is automatically executed by the command.
- If the matching claim is committed, keep the original artifact and complete
  its private delivery after authorization; do not create another identity.
  If commit outcome is still uncertain or the database is unavailable, preserve
  evidence and stop. Once an authorized operator establishes definite rollback,
  retire only that operation's unused artifact under a reviewed procedure.
- A missing/lost/expired committed artifact or a revoked owner requires a
  separately reviewed recovery decision. Bootstrap never resets a password,
  rotates an existing token or deletes a claim/audit to recover access.
- Application rollback leaves committed identity/role/audit/claim unchanged.
  Never restore a database, disable constraints, delete audit history or run
  ad-hoc role SQL to undo/bootstrap again. Revoke access only through a future
  separately approved audited administrative recovery procedure.

## Disposable validation

Run `npm run prisma:generate`, then normal lint/typecheck/unit/build commands.
`npm run test:platform-owner-bootstrap:e2e` creates fresh databases and migrates
only those it creates. Supply an exclusively disposable local PostgreSQL
instance through BOOTSTRAP_TEST_ADMIN_URL, NODE_ENV=test and
BOOTSTRAP_E2E_DISPOSABLE=1; the administrator connection must name `postgres`
on loopback. The tests use only synthetic accounts and private in-memory
activation artifacts, and remove only recorded generated database names. Never
provide a staging/production URL or a local tunnel to one. Hosted full E2E uses
the existing isolated runner database and no production secrets. Missing
infrastructure fails loudly. Production private-file and browser rehearsal are
separate evidence, not inferred from these database tests.

`npm run test:platform-owner-bootstrap:linux` is the explicit Linux CI gate. It
fails on unsupported platforms, runs the filesystem regression tests and the
disposable PostgreSQL suite, including the actual CLI and private-file handoff.
The existing Actions E2E job invokes it against its throwaway Compose stack.
Publishing the branch and obtaining a passing run require separate authorization;
adding a CI step is not evidence that Linux tests have passed.
