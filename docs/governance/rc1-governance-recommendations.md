# RC1 governance recommendations

Scope: `Truevinecloud/TruevineVoice` (public repository, default branch `main`).
Prepared for the RC1 protection lane from `main`
`b0641cec63033748990f48d28d0c04b531be3081`. RC1 integration branch:
`integration/production-release-rc1`
`29cc185c41f807c37684e522228b1cbe29ad8ae8`.

All observations below come from **read-only** `gh api` / `gh pr` commands and
local Git inspection. **No repository setting, branch protection, ruleset,
environment, secret, branch, pull request or production resource was changed or
created.** PR #131 was not replayed, merged, checked out or diffed; no secret
value was read or reproduced. Proposed settings are recommendations for an
owner to approve and apply, not changes made by this work.

## 1. Exact current findings and proposed corrections

### 1.1 Required CI checks before merging

**Current finding — high risk.**

- The only repository ruleset is `AuthorisedCI/CD` (id `25142547`), active,
  source `Repository`, target `branch`, applying to
  `refs/heads/main` only (`conditions.ref_name.include = ["refs/heads/main"]`,
  `exclude = []`).
- Its `rules` array contains only `deletion` and `pull_request`. **There is no
  `required_status_checks` rule**, so no check is required before merging.
- Classic branch protection for `main` returns HTTP 404 `Branch not protected`;
  therefore there are no classic required status checks either.
- The four CI checks that actually ran successfully on the current `main` head
  are the job display names from `.github/workflows/ci.yml`:
  - `Lint, typecheck and Prisma validation`
  - `Unit tests`
  - `End-to-end tests`
  - `Production build`
- PR #132 (the merged RC1 integration PR) also ran path-scoped checks:
  `Disposable-PostgreSQL migration rehearsal`, `database-e2e (billing)`,
  `database-e2e (campaigns)`, `database-e2e (payment-intents)`, `restore` and
  `workflow-checks`. These workflows trigger only on matching path changes (or
  manual dispatch for `restore`), so they cannot be made unconditional required
  checks without changing those workflows.

**Proposed target setting (owner-approved).** Add a required status checks rule
to the `main` ruleset (or equivalent classic protection) with exactly these
contexts and `strict = true` ("Require branches to be up to date before
merging"):

1. `Lint, typecheck and Prisma validation`
2. `Unit tests`
3. `End-to-end tests`
4. `Production build`

Keep the path-scoped checks as advisory unless their workflows are deliberately
changed to run on every pull request. Do not add `format:check` yet: the
repository README records known pre-existing formatting failures.

### 1.2 Required independent PR approval

**Current finding — high risk.**

In the `pull_request` rule of ruleset `AuthorisedCI/CD`:

| Field                                             | Current value                                |
| ------------------------------------------------- | -------------------------------------------- |
| `required_approving_review_count`                 | `0`                                          |
| `required_reviewers`                              | `[]`                                         |
| `require_code_owner_review`                       | `false`                                      |
| `require_last_push_approval`                      | `false`                                      |
| `dismiss_stale_reviews_on_push`                   | `false`                                      |
| `required_review_thread_resolution`               | `false`                                      |
| `require_extra_approval_for_unattributed_changes` | `true`                                       |
| `dismissal_restriction`                           | `{ "allowed_actors": [], "enabled": false }` |
| `allowed_merge_methods`                           | `["merge", "squash", "rebase"]`              |

PR #132 was merged at `2026-11-28T14:15:13Z` with **no reviews recorded**. Open
PR #131 also has no reviews. This is consistent with the configured zero
approvals.

**Proposed target setting (owner-approved).**

- `required_approving_review_count`: at least `1` independent approver (2 for
  production/RC changes if the owner wants a stronger release gate).
- `required_reviewers`: a team or users that do not include the PR author; keep
  `require_last_push_approval = true` so a post-review push cannot be merged
  without re-approval.
- `require_code_owner_review = true` only after an owner-approved `CODEOWNERS`
  file exists. No `CODEOWNERS` file is present today at `CODEOWNERS`,
  `.github/CODEOWNERS` or `docs/CODEOWNERS`.
- `dismiss_stale_reviews_on_push = true`,
  `required_review_thread_resolution = true`, and retain
  `require_extra_approval_for_unattributed_changes = true`.
- Do not count self-review as independent approval; this overlaps with the
  environment control in 1.4.

### 1.3 Restricted branch-protection bypass

**Current finding — high risk.**

- The ruleset bypass actor is
  `{"actor_id": 5, "actor_type": "RepositoryRole", "bypass_mode": "always"}`.
  GitHub's ruleset RepositoryRole id `5` is the **Admin** role (documented
  mapping: maintain `2`, write `4`, admin `5`, see
  `github/rest-api-description#7111`). Any repository administrator can
  therefore always bypass the ruleset, including its pull request rule.
- Classic protection is absent on `main`, so there is no separate
  `enforce_admins` control.
- `integration/production-release-rc1` is not covered by the ruleset and
  its classic branch-protection endpoint returns HTTP 404 `Branch not
protected`. RC1 itself had no merge gate.

**Proposed target setting (owner-approved).**

- Remove the blanket `RepositoryRole` Admin `always` bypass from the ruleset.
- If a break-glass path is genuinely required, restrict it to a named,
  audited release/maintainer team with `bypass_mode = "pull_request"` (not
  `always`) and an owner-documented approval record. Do not rely on a personal
  admin account.
- Extend equivalent protection to `integration/production-release-rc1` (or any
  future RC branch) before using it as a release source.
- Confirm at least two trusted administrators exist before removing bypasses,
  so the repository cannot be locked out.

### 1.4 Production environment self-review restrictions

**Current finding — high risk.**

`GET /repos/Truevinecloud/TruevineVoice/environments/production` reports:

- `protection_rules`: one `branch_policy` and one `required_reviewers` rule
  (id `70947334`).
- `required_reviewers.reviewers`: one `User`, login `benjatruevine`.
- `required_reviewers.prevent_self_review`: **`false`**.
- Only one of the listed reviewers needs to approve a job (GitHub behaviour).
- Deployment branch policy is custom: `custom_branch_policies = true`,
  `protected_branches = false`; the only allowed deployment branch is `main`.

Because `prevent_self_review` is false, the account that dispatches a
production deployment can also approve its own deployment. The same account is
the author of PR #131 and of the merged RC1 PR, so an independent review is not
currently enforced at the `production` environment gate.

**Proposed target setting (owner-approved).**

- Set `prevent_self_review = true` on the production `required_reviewers` rule.
- Replace the single personal reviewer with at least two independent users or a
  dedicated release/operations team, so the requester cannot be the sole
  approver.
- Keep the deployment branch policy restricted to `main`; do not add RC or
  feature branches unless separately approved.

### 1.5 Production environment administrator bypass restrictions

**Current finding — high risk / requires UI confirmation.**

- The REST response for the `production` environment contains no field that
  exposes the "Allow administrators to bypass configured protection rules"
  checkbox. It shows only `branch_policy` and `required_reviewers`; there is no
  wait timer or custom deployment protection rule.
- GitHub's documented default is that administrators **can** bypass
  environment protection rules. The API response does not prove that this
  setting is disabled, so it must be treated as unrestricted until an owner
  verifies it in the repository UI.
- This is independent of the ruleset bypass in 1.3: even with a perfect branch
  ruleset, an administrator could force a production deployment through the
  environment unless this checkbox is cleared.

**Proposed target setting (owner-approved).**

- In `Settings → Environments → production`, clear **Allow administrators to
  bypass configured protection rules** (i.e. administrators may not force a
  deployment past required reviewers).
- Verify after the change by attempting a non-destructive read of the
  environment configuration in the UI; do not test by forcing a deployment.
- Keep the environment branch restriction to `main` and the independent
  reviewers from 1.4.

## 2. PR #131 credential-like artifact disposition

### 2.1 Read-only investigation

| Item            | Finding                                                                                                                            |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| PR              | #131, `Release: TruevineVoice MVP Production (W1-11 through W6-04)`                                                                |
| State           | **Open**, not draft, not merged; no reviews recorded                                                                               |
| Head            | `feat/rbac-013-sensitive-action-audit` @ `a6b175db2a7025cf8e2a91d54debdfdd6e751c40` (branch still exists on `origin`, unprotected) |
| Base            | `main`                                                                                                                             |
| Author          | `benjatruevine`                                                                                                                    |
| Size            | 464 changed files, +51,651 / -861                                                                                                  |
| Artifact status | All paths below are `added` in the PR file list                                                                                    |

Credential-like paths found by filename only (no patch, blob or content was
read):

| Path                                              | Additions |
| ------------------------------------------------- | --------- |
| `.qa-credentials/africas-talking-sandbox-key.txt` | 1         |
| `.qa-credentials/first-live-call-plan.json`       | 22        |
| `.qa-credentials/local-callback-key`              | 1         |
| `.qa-credentials/org-qa-credentials.json`         | 56        |
| `.qa-credentials/w601b-qa-credentials.json`       | 65        |
| `.qa-credentials/w601c-qa-credentials.json`       | 65        |
| `docs/w4-03-sandbox-credential-verification.md`   | 99        |

`docs/w4-03-sandbox-credential-verification.md` is documentation by path; its
contents were **not** inspected, so this review makes no claim about whether it
contains copied values.

Existence check using recursive Git trees (paths only; `truncated = false` for
every tree checked):

| Ref                                             | SHA                                        | `.qa-credentials/*` / verification doc                                             |
| ----------------------------------------------- | ------------------------------------------ | ---------------------------------------------------------------------------------- |
| merged `main`                                   | `b0641cec63033748990f48d28d0c04b531be3081` | **absent**                                                                         |
| merged RC1 `integration/production-release-rc1` | `29cc185c41f807c37684e522228b1cbe29ad8ae8` | **absent**                                                                         |
| PR #131 head                                    | `a6b175db2a7025cf8e2a91d54debdfdd6e751c40` | **present** (including the `.qa-credentials` tree entry and all seven paths above) |

Additional read-only findings:

- `.gitignore` has no `.qa-credentials` rule; `git check-ignore -v` for the
  sample path exits `1` (not ignored).
- Secret scanning, secret-scanning push protection, non-provider patterns,
  validity checks and Dependabot security updates are all reported as
  `disabled`.
- There is no `CODEOWNERS` file.

### 2.2 Risk and rotation recommendation

**Risk: critical.** The repository is public and PR #131 is open; its head
branch and diff are reachable regardless of the fact that the files are not in
merged `main` or RC1. Absence from the merged tree does **not** remove the
exposure. The filenames indicate a provider sandbox API key, a callback key,
several QA credential sets and a live-call plan. This review deliberately did
not determine whether the values are live or placeholders, because doing so
would require reading the secret values.

**Rotation is required.** Treat every credential represented in those files as
compromised:

1. Rotate/revoke the Africa's Talking sandbox key and the local callback key.
2. Rotate/revoke all credentials in the three `*-qa-credentials.json` files and
   the `org-qa-credentials.json` file, plus any token or contact detail in
   `first-live-call-plan.json` that could authenticate or authorize a call.
3. Update the authoritative secret stores and consumers, invalidate the old
   values, and confirm no running deployment still accepts them.
4. Privately review `docs/w4-03-sandbox-credential-verification.md` for copied
   values and rotate anything found there.
5. Do not merge or replay PR #131. Preserve the PR/branch as evidence until the
   owner has completed rotation; afterwards, removal of the remote head branch
   is an owner decision. Removing or rewriting history alone is **not** a
   substitute for rotation, and history rewriting must not be attempted without
   explicit owner authorization (AGENTS.md §16 and §17).

**Additional repository security remediation (owner-approved):**

- Add `.qa-credentials/` to `.gitignore` and add a CI guard analogous to the
  existing `.env` tracked-file assertion in `.github/workflows/ci.yml`.
- Enable secret scanning, push protection, non-provider patterns and validity
  checks; enable Dependabot security updates as a separate deliberate decision.
- Add a `CODEOWNERS` entry for security-sensitive paths if code-owner review is
  enabled under 1.2.
- Re-run the read-only tree checks after cleanup to confirm `main` and release
  branches remain free of `.qa-credentials/`.

## 3. Read-only commands used

All commands below are inspection only. No `PATCH`, `PUT`, `POST`, `DELETE`,
`gh pr merge`, `gh pr close`, `git push`, `git reset` or deployment command was
executed.

```powershell
# Repository, branches and rulesets
gh api repos/Truevinecloud/TruevineVoice --jq '{full_name, default_branch, private, archived}'
gh api repos/Truevinecloud/TruevineVoice/branches/main/protection
gh api repos/Truevinecloud/TruevineVoice/branches/integration/production-release-rc1/protection
gh api repos/Truevinecloud/TruevineVoice/rulesets
gh api repos/Truevinecloud/TruevineVoice/rulesets/25142547 --jq '{id, name, target, enforcement, bypass_actors, conditions, rules}'

# Environments
gh api repos/Truevinecloud/TruevineVoice/environments --jq '.environments[] | {name, protection_rules, deployment_branch_policy}'
gh api repos/Truevinecloud/TruevineVoice/environments/production --jq '{name, protection_rules, deployment_branch_policy}'
gh api repos/Truevinecloud/TruevineVoice/environments/production/deployment-branch-policies --jq '.branch_policies[] | {id, name, type}'

# Observed checks and review state
gh api repos/Truevinecloud/TruevineVoice/commits/b0641cec63033748990f48d28d0c04b531be3081/check-runs --jq '.check_runs[] | {name, status, conclusion, app: .app.name}'
gh pr checks 132 --repo Truevinecloud/TruevineVoice
gh pr view 131 --repo Truevinecloud/TruevineVoice --json number,title,state,mergedAt,headRefName,baseRefName,author,url,changed_files,additions,deletions,reviews
gh pr view 132 --repo Truevinecloud/TruevineVoice --json number,title,state,mergedAt,headRefName,baseRefName,reviews

# PR #131 file names and counts only (no patch/content)
gh api repos/Truevinecloud/TruevineVoice/pulls/131/files --paginate --jq '.[] | [.status, .filename, .additions, .deletions] | @tsv' | Where-Object { $_ -match 'qa-credentials|w4-03-sandbox-credential-verification' }

# Tree existence checks (paths only; verify truncated = false)
gh api "repos/Truevinecloud/TruevineVoice/git/trees/b0641cec63033748990f48d28d0c04b531be3081?recursive=1" --jq '.tree[].path' | Where-Object { $_ -match 'qa-credentials' }
gh api "repos/Truevinecloud/TruevineVoice/git/trees/b0641cec63033748990f48d28d0c04b531be3081?recursive=1" --jq '.truncated'
gh api "repos/Truevinecloud/TruevineVoice/git/trees/29cc185c41f807c37684e522228b1cbe29ad8ae8?recursive=1" --jq '.tree[].path' | Where-Object { $_ -match 'qa-credentials' }
gh api "repos/Truevinecloud/TruevineVoice/git/trees/a6b175db2a7025cf8e2a91d54debdfdd6e751c40?recursive=1" --jq '.tree[].path' | Where-Object { $_ -match 'qa-credentials' }

# Local repository hygiene checks
gh api repos/Truevinecloud/TruevineVoice --jq '{security_and_analysis}'
git check-ignore -v .qa-credentials/africas-talking-sandbox-key.txt
git ls-files CODEOWNERS .github/CODEOWNERS docs/CODEOWNERS
```

## 4. Summary

| Area                    | Current                                                           | Recommended target                                                                                          |
| ----------------------- | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Required CI checks      | None enforced                                                     | Four core CI check contexts, strict/up-to-date                                                              |
| Independent PR approval | 0 approvals; no reviewers; merged RC1 had no reviews              | ≥1 independent approval, last-push approval, stale dismissal, thread resolution                             |
| Branch bypass           | Admin role bypasses ruleset `always`; RC branch unprotected       | Remove blanket Admin bypass; audited team-only `pull_request` bypass if needed; protect RC branch           |
| Production self-review  | `prevent_self_review = false`; one personal reviewer              | `true`; two independent reviewers/team; keep `main` only                                                    |
| Production admin bypass | API cannot show it; GitHub default allows bypass                  | Owner clears "Allow administrators to bypass configured protection rules"                                   |
| PR #131 artifacts       | Credential-like files only on open PR head, not in merged main/RC | Rotate/revoke all represented credentials; add ignore/CI guard; enable secret scanning; do not merge/replay |
