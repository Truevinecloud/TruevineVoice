# Developer-controlled Test Account Seeder

Implementation is prepared for isolated non-production use only. No live account has been created or verified. `voice.truevinecloud.online` is identified as production in repository deployment configuration and is rejected, even if NODE_ENV is changed. This seeder has no production override. Reclassification or a separate production procedure, deployed through the existing reviewed CI/CD workflow, is required before considering that host. Do not run code by editing the running release.

## Prerequisites and exact execution

Use a trusted Linux operator terminal with history/session recording disabled for secret entry. The secure reader requires an absolute regular JSON file outside the checkout, operator ownership, mode 0600, no symlink/hard link, in an operator-owned 0700 directory with safe ancestors. Windows credential-file execution fails closed. Do not use command-line passwords, environment passwords, shell heredocs containing passwords, CI secrets for this command, email capture or activation links.

1. Verify a genuinely disposable database and dedicated PostgreSQL role. Explicitly export `NODE_ENV=test`, `TEST_ACCOUNT_SEEDER_ENABLED=1`, a loopback `DATABASE_URL` whose database is `truevine_bootstrap_test_<16 lowercase hex characters>` with no query options, and a loopback HTTPS `WEB_PUBLIC_URL`. Do not load a production environment or use a tunnel to production. No migrations or infrastructure are created automatically.
2. The existing approved singleton bootstrap must already identify `qa-platform-owner@example.invalid`. Its status must be ACTIVE, its role PLATFORM_OWNER, with no organization memberships, and its current password must be known privately. The seeder cannot bootstrap, reset, reactivate or replace that account. If no such account exists, use the existing separately approved bootstrap procedure. That existing procedure currently requires activation to establish its initial password. This implementation deliberately does **not** introduce an alternate no-activation first-owner path; all eleven no-link logins therefore require an already initialized test owner. This prerequisite is an explicit limitation for a fresh database.
3. Use an approved local password manager or non-recorded private editor to create the protected JSON file. Its structure is `version` equal to 1, `action` equal to `seed`, and `passwords` mapping each of the eleven inventory emails below to its privately chosen password. All eleven keys are mandatory; passwords must differ, be nonblank and satisfy the existing 12–200 character policy. For the existing test Platform Owner, supply its current password. No real password belongs in documentation or a committed sample file.
4. From the verified release/check-out root, run `npm run build:packages`, then `npm run test-accounts:seed -- --config /absolute/private-directory/accounts.json`. Only the file path is an argument. The transaction creates organization name/slug `truevoice-testing` and ten new users with salted Argon2id hashes, role assignments and append-only audit provenance. It emits a non-secret inventory only. No mail, activation/reset token or fabricated terms acceptance is created.
5. Change only the private file's action to `verify` and run `npm run test-accounts:verify -- --config /absolute/private-directory/accounts.json`. This verifies current status, exact role scope, seeder audit provenance and supplied passwords without writes. `passwordVerified` is a credential/hash check, not proof of a browser session, lockout/rate-limit state or deployed HTTP routing. Reconcile any error through trusted read-only inspection; no credentials are changed on conflict.

## Inventory and login instructions

| Role | Email | Provisioning behavior |
| --- | --- | --- |
| Organization OWNER | qa-owner@example.invalid | New member of truevoice-testing |
| Organization ADMIN | qa-admin@example.invalid | New member of truevoice-testing |
| CAMPAIGN_MANAGER | qa-campaign-manager@example.invalid | New member of truevoice-testing |
| Organization BILLING | qa-billing@example.invalid | New member of truevoice-testing |
| VIEWER | qa-viewer@example.invalid | New member of truevoice-testing |
| PLATFORM_OWNER | qa-platform-owner@example.invalid | Verify existing approved bootstrap identity only |
| OPERATIONS_ADMIN | qa-operations-admin@example.invalid | New platform assignment, no tenant membership |
| BILLING_ADMIN | qa-billing-admin@example.invalid | New platform assignment, no tenant membership |
| SUPPORT_ADMIN | qa-support-admin@example.invalid | New platform assignment, no tenant membership |
| TECHNICAL_ADMIN | qa-technical-admin@example.invalid | New platform assignment, no tenant membership |
| AUDITOR | qa-auditor@example.invalid | New platform assignment, no tenant membership |

`admin@truevoice.com` is an additional preserved identity, not one of the eleven. If present in the explicitly selected isolated database, only its status/membership/platform-role metadata is read; its password is neither selected nor changed. No production inspection has been performed.

Open the **verified non-production** configured WEB_PUBLIC_URL followed by `/sign-in`, in a separate private browser session per identity. Enter the email above and its password from the private configuration/password manager. Accept current terms personally when prompted. Customer roles select `truevoice-testing` and use `/app`. Platform roles use the configured admin interface (normally `/admin`, accessible only through its established protected route/tunnel); the frontend and API must point to the same isolated environment. Do not expose admin publicly or point these logins at the production URL.

Use the [permission matrix](../qa-role-permission-matrix.md) for allowed/denied actions. It describes roles, while its original organization `qa-role-test-kit` belongs to the activation-based kit; this seeder uses `truevoice-testing`. Billing Admin still has no implemented platform billing endpoint/dashboard. Other missing endpoints in that matrix remain unavailable even with a successful login. Confirm API 403s with valid session, CSRF and terms, as well as hidden UI actions. Verify a second synthetic tenant is inaccessible. No real email inbox is used.

## Disable and cleanup

Set private action to `disable`, retaining the current passwords, and run `npm run test-accounts:disable -- --config /absolute/private-directory/accounts.json`. This explicitly authorizes suspension of **only the ten accounts with this seeder's audit provenance**; sessions are revoked and outstanding reset tokens expire. Exact scopes and passwords are checked before any writes. Repeating disable is safe. Seeder runs never reactivate suspended users. Any missing identities are reported absent.

The pre-existing bootstrap owner and `admin@truevoice.com` remain unchanged. To disable the bootstrap owner itself requires a separate explicitly authorized owner-lifecycle procedure, preserving the immutable claim. The organization, assignments and append-only audits are retained; no rows, ledger entries or claim are deleted. Retire the private password file/shares through the operator's secure disposal policy after verification/cleanup; do not commit or attach them to a report. Existing activation-kit accounts are refused as unmanaged, rather than silently adopted or having their passwords replaced.

## Deployment boundary

Code delivery uses the existing CI/CD PR/main checks and human-authorized production workflow. Seeding is **never** a deployment hook or CI job. No password file is uploaded to Actions. No workflow gates, migration approvals or immutable bootstrap controls have been relaxed. A deployed binary does not authorize executing it against production. This branch has not been pushed or deployed by this task.
