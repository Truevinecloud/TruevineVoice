# Infrastructure

Support material for the environments Truevine Voice runs in.

## Layout

```
infrastructure/
  docker/          # Local development containers (see docker/README.md)
  environments/    # Per-environment notes and configuration (deferred)
  scripts/         # Operational helper scripts (deferred)
```

## Current state

The only provisioned infrastructure is defined in the repository-root
`docker-compose.yml`, which provides **local development** PostgreSQL and Redis.
That is sufficient for the engineering foundation; nothing has been deployed.

Application processes run on the host during development rather than inside
containers, so that hot reload, breakpoints and test output behave normally.

## Deliberately deferred

- Container images for `apps/web`, `apps/api` and `apps/worker`.
- Kubernetes or any other orchestrator manifests.
- Terraform or other infrastructure-as-code.
- Secrets management integration.

Each of these is deferred until there is a deployment target to deploy to.
Adding manifests for an orchestrator that is not in use would be speculative.
