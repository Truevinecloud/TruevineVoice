# RBAC-001 release blockers

> Security-remediation update: see [ADR 0010](adr/0010-rbac-001-security-transactions.md) and the [remediation report](rbac-001-security-remediation.md). Earlier defect findings are historical; migration production approval and release dependencies remain withheld.


Release limitations and defects are listed below. Verification evidence is scoped
to the local development environment; see [final verification](rbac-001-final-verification.md).

`DEPLOYMENT_READY=false`. Draft PR #13 is published; nothing has been merged or deployed.

The [merge-readiness review](rbac-001-merge-readiness-review.md) identifies code
security blockers separately from the deployment prerequisites on this page.
Recommendation: **NOT MERGE READY**.

---

## 1. No terms document exists — **release blocker**

Terms acceptance is enforced against the version string `2026-10-01`. There is no
text behind that version. `GET /auth/terms` returns `url: ''` rather than a link
to a page that does not exist, and the acceptance screen says so in as many
words.

This is a product and legal decision, not an engineering one. It needs:

- the actual terms text, agreed by whoever owns the customer relationship;
- a canonical URL to serve it from;
- a retention rule for recorded acceptances — how long, and what happens to a
  user who accepted version 1 when version 2 is published.

Until the first exists, the system records acceptance of a number with nothing
behind it. That is honest but it is not releasable: accepting terms nobody can
read is not consent.

## 2. No email provider is configured — **release blocker**

Three transports exist (`null`, `development`, `http`). `EMAIL_TRANSPORT=http`
**fails at startup** if no endpoint is configured, rather than silently
downgrading.

`EMAIL_ENDPOINT` and `EMAIL_AUTHORIZATION_HEADER` do not exist in any environment.
Therefore:

- **password reset does not work in production** — the email containing the link
  is never delivered;
- **invitations do not work in production** — nobody receives an invitation.

Both flows are implemented and exercised against the development capture
transport. Neither has been tested against a real provider, and neither should be
described as production-ready until one is configured and a message has actually
arrived.

### The development capture transport

`DevelopmentCaptureEmailSender` writes each message to `.email-capture/` with
`mode: 0o600`. Verified:

- the directory is gitignored, and `git status` shows no capture file;
- every rendered message is headed "THIS MESSAGE WAS NOT SENT";
- no password appears in any captured file — only the single-use token in the
  reset link.

**On Windows, `mode: 0o600` is not enforced** the way it is on POSIX; the
directory ACL governs instead. Treat captured messages as secrets. The startup
banner warns, but the transport now refuses to activate when `NODE_ENV=production` (unit tested).

## 3. Personal-data erasure needs a policy decision

Account deactivation and organization suspension are implemented as reversible
suspension (see ADR 0009). **Erasure is not implemented, and cannot be until
policy exists.**

Deletion is blocked by design — `security_audit_events` cascades from
`organizations` and restricts on `users`, so deleting either is refused by the
database once it has audit history. Erasure must therefore be **anonymisation**:
overwrite identifying fields, keep the row, keep the trail.

Open questions, none of which this codebase should answer unilaterally:

- What counts as identifying for a user who was both a member and an audit actor?
- Must audit rows containing their user id be scrubbed, or retained under a
  legitimate-interest basis?
- What is the retention period for each record type?
- Does the answer differ for an active customer, a former customer, and a
  customer whose organization has been suspended?

## 4. Platform denials by callers with no organization are unrecorded

`security_audit_events.organization_id` is `NOT NULL` with a foreign key. A
platform-scoped denial from a caller with no organization context has no row to
go into. Inventing one would either violate the constraint or fabricate a tenant
association.

Needs a platform-scoped audit table. **RBAC-002 work**, deliberately not started.

A related, narrower gap: a denial against an organization id that **does not
exist** cannot be filed for the same reason. Skipping it is semantically correct —
nobody was targeted — but it is now written to stderr, so it is distinguishable
from a genuine audit outage.

## 5. Four migrations are unreviewed

Reviewed in `docs/migrations-rbac-001-review.md`. Three things must happen before
approval:

1. Re-run against a staging database seeded to the expected production volume.
   The destructive `MembershipRole` swap is only safe while `memberships` and
   `invitations` are empty — verified by replaying the exact `USING` clause
   against an `OPERATOR` row and watching it fail. That is a property of the data,
   not of the script.
2. Settle how `citext` is installed. It is trusted and can be installed by a
   non-superuser with CREATE on the current database; verify the migration role
   privileges and extension availability in staging.
3. Decide what rollback means for the two migrations whose rollback destroys audit
   history.

`infrastructure/migrations-reviewed.json` is deliberately untouched, so
`deploy:release` refuses this tree.

## 6. No interactive browser verification

No desktop browser was connected to this session, so the UI was verified by
driving `http://localhost:3000` over HTTP and asserting on rendered HTML, status
codes, redirects and `Set-Cookie` headers. Every page in this application is
server-rendered, so that is what a browser receives — but it does **not** exercise
JavaScript-driven interaction after hydration: client-side validation, button
disabled states, loading spinners, optimistic updates.

Worth doing before release with a real browser driver. 41 checks currently pass
(see `npm run verify:frontend`).

## 7. Known API gaps, deliberately out of scope

Documented rather than stubbed:

- No password **change** from the account screen. Reset flow only.
- No email-change flow.
- No role-edit control in the team UI, though the API supports it.
- No role assignment from the invitations screen beyond what the invite form does.

---

## Verification and remaining lifecycle defect

See [the final verification report](rbac-001-final-verification.md) for executed
checks and exact counts. Earlier session counts are superseded.

Inspection found that account deactivation recovery is incomplete:
`AuthService.completePasswordReset` changes the hash and revokes sessions but
does not return a SUSPENDED user to ACTIVE. The ADR describes reset as the
reactivation flow; that behavior is not implemented. Recovery was not tested
end to end in this session and must not be claimed as working. A policy and
implementation correction is required before releasing account deactivation.
