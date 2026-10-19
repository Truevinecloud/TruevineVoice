# Draft RBAC database test snapshot

This branch copies the authorized pending RBAC-004 billing and RBAC-005 Viewer/reporting implementation from the unchanged development worktree, including required RBAC-003 campaign dependencies. It is for hosted tests only, not release approval. No RBAC-006 implementation is included.

The CI-only configuration is based on draft PR #26. Isolated billing/campaign jobs use disposable PostgreSQL and Redis services without secrets. Full PR CI and migration rehearsals also run on disposable infrastructure. The security rehearsal's exact expected list includes the billing migration, and its ledger assertions now require all nine migrations; unknown later migrations still fail. The production migration approval manifest remains unchanged.

Payment collection and settlement remain unavailable. Requests stay pending and do not credit wallets. No merge, deployment, production migration approval, production data access or database reset is authorized by this snapshot. Current backup recovery, SQL/human migration approval and browser acceptance remain separate release prerequisites.

The original branch and all pending files remain intact. Corrections made while testing this snapshot stay on this test branch until separately reviewed and reconciled with development work.
