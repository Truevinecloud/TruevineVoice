# RBAC-014: proposed one-time solo-maintainer release exception

**Status: AUTHORIZED for the one-time release below.** Prepared 2026-10-22.
Authorization recorded 2026-10-22 09:01:25 UTC from the accountable owner's
explicit message in the release conversation following proposal commit
`6e08e170f8c99a19a9b8a6d83a6f9367e7ce41da`. This records a solo-maintainer
exception, not independent security approval or monitoring verification.

## Owner authorization record

The owner explicitly stated:

> I authorize the one-time solo-maintainer release exception documented in commit
> `6e08e17` for Truevine Voice RBAC-014 release
> `ac16a99cbca8b18367266a9d2432d57a80736b1e`.
>
> As the accountable release owner, I accept the documented medium-severity
> monitoring risk, take responsibility for the interim log-inspection controls,
> and commit to the specified monitoring remediation deadline.
>
> This authorization applies only to RBAC-014 and does not establish a permanent
> exemption from independent security review.

The timestamp above is when this record was captured, not a claim about the
message's server timestamp. The approved terms below are preserved. The owner
accepts the interim controls; no collector, alert delivery or production logging
configuration is represented as independently verified by this authorization.

## Scope and authority

This proposal applies only to production release
[`ac16a99cbca8b18367266a9d2432d57a80736b1e`](https://github.com/Truevinecloud/TruevineVoice/commit/ac16a99cbca8b18367266a9d2432d57a80736b1e).
It proposes replacing the separate independent-review approval requirement for
this release with an explicit, attributable solo-maintainer release decision.
It is not a standing waiver or a security approval by an independent reviewer.

The owner declares that Truevine Voice has one developer, production
administrator and accountable release owner: **@benjatruevine**. The production
runbook assigns release approval to a release approver; the RBAC-014 record
additionally requires independent review. Existing documents define neither a
solo-maintainer exception nor a delegated waiver authority. Owner status does
not silently satisfy the independent-review requirement. As the declared sole
project owner, @benjatruevine may explicitly adopt this narrow policy amendment
and accept its release risk; this is a proposed new approval path, not a claim
that the existing policy already permits self-issued independent approval.

Only that owner may authorize this proposal. An agent, passing CI, PR creation,
or a merge without explicit authorization text does not authorize it. Any actual
GitHub environment or branch protection must still be obeyed. This exception
does not apply to first-owner bootstrap or other independently approved actions.

## Review and operational evidence retained

- The earlier security review concluded CHANGES REQUIRED. The SessionGuard
  denial-audit logging defect was remediated through merged PR #50. The technical
  re-review of the exact target found no remaining high-severity authorization
  or tenant-isolation defect; it did not provide separate independent approval
  because the reviewing agent had also authored the remediation.
- The reviewed controls remain unchanged: organization/actor/login-session
  binding; SUPPORT_ADMIN-only context creation and diagnostics; 15-minute expiry;
  revocation and per-request enforcement; fail-closed audit-failure handling;
  safe structured operational error logging; additive migration compatibility.
  See [the remediation report](rbac-014-session-denial-remediation.md), PR #50 and
  the security-review responses in the release-owner conversation. No prior
  CHANGES REQUIRED decision is relabelled APPROVED or erased by this proposal.
- Exact-target four-job push CI passed. The operator supplied: healthy
  PostgreSQL; 55 GB disk available; no active transactions or lock waits;
  sessions table previously verified empty; October 22 checksum verification,
  successful isolated restore of 22 public tables, and verified encrypted
  off-server backup. This proposal accepts that supplied evidence without
  rerunning CI or infrastructure/recovery checks.
- Migration locking, possible partial application, stop-and-inspect recovery,
  and code-only rollback retaining the additive schema remain applicable.
  This exception does not authorize a blind migration retry, resolve, reset,
  migration edit or direct production data repair.

## Monitoring risk and time-limited acceptance proposal

**Medium residual risk:** production collection and alert delivery for
`support_access_denial_audit_failed` are not verified. Requests remain denied if
audit persistence fails, but the fallback event could remain unnoticed in local
logs or lose durable evidence. Active rsyslog and available imfile do not prove
API ingestion, safe parsing, retention or alert delivery.

**Accountable risk owner and remediation owner:** @benjatruevine, acting as sole
production administrator and release owner. This assignment is proposed for
explicit acceptance, not an assertion that acceptance has already occurred.

**Deadline:** 2026-10-23 12:00 Africa/Nairobi (09:00 UTC), or 24 hours after
deployment, whichever is earlier. The exception cannot be used for a first
dispatch after this deadline. There is no automatic extension. If remediation
is incomplete at expiry, the owner must record the incident and a fresh explicit
risk decision before further support-access releases; expiry does not trigger
an automatic rollback, role change or deletion of audit evidence.

During any accepted interval, the owner must retain and manually inspect the
actual API error logs at least hourly and after deployment. If that interim
visibility cannot be established, do not dispatch under this proposal. Audit
failure signals require immediate investigation; never disable authorization
or audit controls to restore availability.

Completion requires the evidence specified by
[the monitoring runbook](runbooks/support-access-audit-alerting.md): effective
PM2 source, collector identity/access and rotation; prefixed and bare JSON
parsing; restricted durable retention; exclusion of tokens/credentials/request
content; alert query and named routing/escalation; and an acknowledged synthetic
delivery test. Use an approved synthetic facility, not a deliberately broken
production audit store. Monitoring remains unverified until that evidence exists.

## Explicit authorization and subsequent release

The shortest auditable authorization is an owner-authored statement in the
focused documentation PR or this release conversation, linked to this document
revision. Preserve its author, UTC timestamp and permalink/message reference.
The statement must explicitly adopt the exception, acknowledge the lack of
independent approval, accept the medium monitoring risk and the interim controls,
and accept the owner and deadline. For example:

> I, @benjatruevine, as sole project owner and accountable production release
> owner, authorize this one-time RBAC-014 solo-maintainer policy exception for
> ac16a99cbca8b18367266a9d2432d57a80736b1e. I acknowledge that no separate
> independent security approval has been supplied. I accept the recorded medium
> monitoring risk, interim log-retention/manual-inspection controls, and personal
> responsibility for remediation by 2026-10-23 12:00 EAT or 24 hours after
> deployment, whichever is earlier. The supplied CI and operational evidence
> are accepted for this release. I authorize the existing CI/CD production
> dispatch after this authorization is recorded and the interim controls are met.

**The example is not an authorization.** Record the actual reference and time
before dispatch. No additional generic confirmation is needed after an adequate
explicit owner statement; execute only within its scope.

Keep this documentation branch/PR separate from `main` until the selected
release is dispatched: the unchanged workflow requires the selected SHA to be
current `main`. An approved external/PR record can authorize this one-time
exception without changing application source or pretending that the policy
was already present in the target commit. If the documentation is merged first,
`main` changes: stop and reconcile the target and its normal exact-SHA CI rather
than deploying a different commit under this record.

After authorization, use only the existing main-only production workflow with
`authorize_production=true`, retaining all CI, manifest, migration, deployment
locking, verification and rollback safeguards. No application code, permissions,
secrets or deployment workflow changes are proposed. Record the deployment run,
outcome, deployed SHA and monitoring completion evidence after those events.

## Deployment outcome — 2026-10-22

- Owner authorization was recorded in documentation commit `a5f6607` on this
  separate branch; `main` remained the exact authorized target.
- Existing production workflow
  [run 39752331337, deployment #54](https://github.com/Truevinecloud/TruevineVoice/actions/runs/39752331337)
  was explicitly dispatched with `authorize_production=true` and completed
  successfully for `ac16a99cbca8b18367266a9d2432d57a80736b1e`.
- At 09:06:58 UTC the workflow reported the verified deployment and saved PM2
  state. Its existing migration/activation checks completed without a reported
  failure. This is workflow evidence, not a separate live migration-ledger query.
- Independent post-deployment public HTTP verification at 09:24:26 UTC returned
  `status: ok`, `environment: production`, the exact authorized version, and
  PostgreSQL/Redis `up`; the homepage returned HTTP 200.
- Backup, restore, disk and other completed preflight checks were not repeated.
  No application code, workflow, production logging configuration or unrelated
  worktree was modified. The workflow's Ubuntu runner-image transition notice
  was informational and did not fail the deployment.
- Audit collection and alert delivery remain unverified. The accepted monitoring
  owner remains @benjatruevine and the effective deadline remains
  **2026-10-23 12:00 EAT (09:00 UTC)**, earlier than 24 hours after activation.
  Deployment success is not monitoring-completion evidence. Interim controls
  and the non-permanent scope of the owner exception remain applicable.
