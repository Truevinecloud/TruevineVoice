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

## Platform roles and current blocker

`OPERATIONS_ADMIN` is a platform role, not an organization membership role.
The repository currently has no supported platform-role grant/provisioning
command or audited application workflow. Platform role assignments are not
exposed through the Operations Admin API or UI, and this change does not add a
role-management endpoint. Do not assign the role with ad-hoc SQL or reuse the
organization Owner command; neither is an approved platform-role provisioning
path. A staging Operations Admin UAT account remains blocked until a separately
reviewed, auditable non-production provisioning mechanism is approved and
implemented. Production role assignment is out of scope.

## Environment safety

Before provisioning, verify the environment and database identity from the
staging operator console. The database must be a dedicated non-production
database with synthetic data, and the activation URL must use the staging HTTPS
origin. Keep database credentials and activation files out of source control,
shell transcripts, CI output, and shared tickets. No payment, voice, SMS, or
customer notification integrations should be enabled in UAT.
