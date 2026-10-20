# Non-production UAT account provisioning

This runbook describes the account flows that are currently supported. Use a
dedicated staging/test deployment and synthetic addresses/data only. Do not
provision UAT accounts in production.

## Organization roles

1. An authorized staging operator provisions the first `OWNER` for a new,
   memberless test organization with the existing `npm run provision:owner`
   command. The script refuses an existing email or an organization that already
   has members. It creates a random unusable password hash and a single-use,
   24-hour activation token in a private local file; it never prints the token
   or sets a password. Use the staging web origin for `--base-url`, keep the
   activation file outside Git, deliver the link privately to the intended
   tester, and delete the file after activation.
2. The activated Owner invites separate synthetic users as
   `CAMPAIGN_MANAGER`, `BILLING`, and `VIEWER` through the authenticated
   organization member invitation endpoint/UI. The invitee accepts using the
   same email address, sets their own password through the activation flow, and
   receives the role from the invitation. Invitation creation/acceptance is
   recorded in the organization audit stream. Never share passwords between
   accounts.
3. Verify each role using its own browser profile and confirm the expected
   allow/deny behavior. Revoke unused invitations and remove test membership
   through the application after UAT.

## Platform Operations Admin

`OPERATIONS_ADMIN` is a platform role, not an organization membership role. The
UAT-only operator command `npm run provision:operations-admin-uat` creates a
new account with a cryptographically random unusable password, assigns only
`OPERATIONS_ADMIN`, stores a single-use 24-hour activation-token hash, and
records `platform.operations_admin.provisioned` in the immutable identity audit
stream in the same database transaction. It accepts no existing account and
never resets a password or changes a role. The actor must be an active
`PLATFORM_OWNER`; that actor and an approved ticket/reference are recorded on
the grant. There is no API/UI role-management endpoint.

Run only from the staging operator environment after a separate operator has
verified the staging target and the approved UAT request. Set `NODE_ENV=staging`,
`UAT_PROVISIONING_ENABLED=1`, and `DATABASE_URL` to a staging/UAT database named
`truevine_staging...` or `truevine_uat...` (the command rejects loopback/local
development databases outside its fixed disposable-CI test). Never source the
production environment file or paste a connection string into command history.
Use a synthetic tester address and an HTTPS staging URL:

```powershell
$env:NODE_ENV = 'staging'
$env:UAT_PROVISIONING_ENABLED = '1'
$env:DATABASE_URL = Get-Content 'C:\secure\staging-database-url.txt' -Raw
npm run provision:operations-admin-uat -- `
  --email 'ops-uat-<request-id>@example.invalid' `
  --actor-user-id '<active-PLATFORM_OWNER-uuid>' `
  --approval-reference 'UAT-REQ-123' `
  --base-url 'https://staging.truevinecloud.online' `
  --activation-directory 'C:\secure\uat-activation'
```

Keep the activation file outside the repository and readable only by the
operator; transfer its single-use link privately to the named tester, ask them
to set their own password, then securely delete the file. Do not send the token
in email, chat, tickets, CI output, or shell transcripts. The CLI refuses
production-looking database names, ordinary local databases, non-HTTPS URLs,
unapproved references, inactive/non-`PLATFORM_OWNER` actors, and existing user
accounts. A production target, payment/voice integration, or production role
assignment is unsupported by this command.

The actual staging environment must already have an approved active
`PLATFORM_OWNER`. If that precondition is not met, use only the separately
approved first-owner bootstrap process in [the bootstrap runbook](platform-owner-bootstrap.md).
Its local implementation does not approve staging or production execution.
Never seed or assign a platform role with ad-hoc production SQL.
The CI rehearsal tests this command only against a fixed disposable PostgreSQL
database with synthetic actors, verifies denial/allow/audit/activation/retry,
then drops that database.

## Environment safety

Before provisioning, verify the environment and database identity from the
staging operator console. The database must be a dedicated non-production
database with synthetic data, and the activation URL must use the staging HTTPS
origin. Keep database credentials and activation files out of source control,
shell transcripts, CI output, and shared tickets. No payment, voice, SMS, or
customer notification integrations should be enabled in UAT.
