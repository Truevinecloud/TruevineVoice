# Isolated QA Role Test Kit

This procedure never targets production, never reuses `admin@truevoice.com`, and never resets an existing credential. Use the [generated inventory/matrix](../qa-role-permission-matrix.md). Five customer users share the dedicated `qa-role-test-kit` organization; six platform users have no organization memberships.

The existing QA Owner `admin@truevoice.com` is preserved outside this isolated inventory. Do not copy that account or its credentials into the disposable database. `qa-owner@example.invalid` is an independent test stand-in for the OWNER role. The other ten role identities are listed explicitly in the matrix; the test Platform Owner must use the existing bootstrap procedure below.

## Prepare and provision

1. On a trusted Linux operator machine, create a new disposable PostgreSQL database named `truevine_bootstrap_test_<16 lowercase hex characters>`, on loopback. Use a dedicated database principal with access only to that database. Do not use a production clone or production credentials. Apply reviewed migrations through the existing root Prisma scripts in this disposable environment only. This kit does not create databases or apply migrations.
2. Run the test web/API/admin applications against that same database. Supply a loopback HTTPS `WEB_PUBLIC_URL` with a locally trusted certificate. Set `NODE_ENV=test`, `QA_ROLE_KIT_ENABLED=1`, and explicitly export `DATABASE_URL` with no URL query options. The kit never loads `.env` files.
3. Follow [the existing Platform Owner bootstrap procedure](platform-owner-bootstrap.md) for **test only**, with `qa-platform-owner@example.invalid`, the exact isolated database target and loopback HTTPS origin. Its private approval file, stable operation UUID, opt-in and immutable singleton claim are mandatory. This is a prerequisite, not a second owner bootstrap implementation. If already bootstrapped, verify the existing identity/claim; do not rerun bootstrap or replace its token.
4. Create an operator-owned absolute private directory outside every Git checkout (mode 0700, no symlinks). Run `npm run qa:provision -- --activation-directory <private-directory>`. Windows fails closed when a credential artifact is required. Provisioning checks the connected database name, serializes kit runs with a PostgreSQL transaction advisory lock, and creates ten users atomically. Serializable conflicts fail and can be retried after reconciliation. Reruns verify all eleven role assignments and leave credentials/tokens unchanged. Suspended or mismatched identities fail rather than being repaired. Never remove the immutable bootstrap claim.
5. Reconcile all eleven identities, role assignments, organization memberships and successful provisioning audit records against the inventory before delivery. The reused secure artifact writer names files `platform-owner-<uuid>.json`; each payload identifies its actual kit role and email. Do not infer the role from the filename. The bootstrap owner's artifact is from step 3.

## Secure delivery and ambiguous results

Each account receives an independent cryptographically random activation token, stored only as a hash in PostgreSQL. Its random initial password is never disclosed. The recipient sets a unique password through the existing `/set-password` flow. The existing single-use expiry contract applies; no kit command refreshes expired tokens.

Read private artifacts only in the trusted operator context. Send each recipient only their own activation link using an approved encrypted password-manager share with recipient verification and expiry. Do not paste links, token hashes, passwords or database URLs into terminals with recording, chat, tickets, Git, CI output or screenshots. Disable browser synchronization and avoid recording the activation URL. `.invalid` identifiers are deliberate local QA logins; this procedure uses manual private delivery and does not send email.

A crash, timeout, disconnect error or lost commit response can leave a committed database transaction or an unused private artifact. Artifacts are retained on failure deliberately. Do not deliver until reconciling the committed user and token hash securely. Retry verifies existing accounts without rotating credentials. Quarantine orphan artifacts; delete them through the operator's approved secure disposal procedure only after reconciliation. Lost or expired artifacts require a separate approved non-production recovery procedure; this kit does not change credentials to recover them.

## Manual login checklist (repeat for every inventory row)

- Use a new private browser session for each role. Confirm loopback HTTPS origin and isolated API database configuration before activation.
- Open only that role's private activation link, set a unique password, verify token reuse is refused, then remove the delivered share and artifact according to the secure disposal policy.
- Sign in with the inventory email; accept current terms personally when prompted. The provisioner does not fabricate terms acceptance. Confirm logout invalidates the session and the previous session cannot access a protected page.
- For customer roles, select only `qa-role-test-kit`. Exercise permitted reads and writes from the matrix using disposable records. Verify denied actions directly at the API as well as hidden navigation, with valid session, CSRF and terms so a 403 tests authorization. Attempt access to a second disposable organization and verify rejection.
- OWNER: organization/member/invitation management, billing, campaign/contact actions; no platform access. ADMIN: management/campaign/contact actions; deny wallet, billing and ownership transfer. CAMPAIGN_MANAGER: campaign/contact actions; deny membership management and billing. BILLING: billing/wallet actions; deny campaigns and reporting. VIEWER: organization/member/campaign/report reads; deny all mutations.
- Platform roles: use the implemented operations, support, technical or audit pages/API listed by the matrix. Verify each permitted permission and each denied permission at the guard/HTTP boundary. For PLATFORM_OWNER, verify no tenant membership is implied; its platform authority does not grant customer API access. For BILLING_ADMIN, record the absent billing dashboard/API as unavailable, not a successful allowed action.
- Support diagnostics additionally require the existing reason, scoped support session and audit controls. Do not treat a permission grant alone as authorization to bypass them.
- Record role, action, expected/actual status and redacted evidence only. Missing endpoints/dashboards are limitations, never passing tests. No paid external operations, production account creation, deployment or production bootstrap is part of QA.

## Local verification

Run `npm run qa:matrix`, `npm run test:qa-role-kit`, `npm test`, `npm run lint`, `npm run typecheck`, and `npm run build`. Existing HTTP suites test implemented endpoint behavior; guard tests test permission cells. Real database provisioning, concurrency, filesystem durability and browser login must be rehearsed separately on the isolated Linux environment; fake-based unit tests do not establish those properties.
