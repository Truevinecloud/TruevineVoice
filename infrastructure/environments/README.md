# Environments

Reserved for per-environment configuration and notes.

**Status: intentionally empty.** Only local development exists. There is no
staging or production environment to describe yet.

## Expected future contents

One file per environment (`development`, `staging`, `production`) describing:

- Which infrastructure the environment runs against.
- How secrets reach the environment (secret manager, never a committed file).
- Which migrations have been applied and the rollback position.
- Who to contact when it breaks.

Environment variables are validated at start-up by each app. A missing or
malformed value must fail the boot, not degrade silently at runtime.
