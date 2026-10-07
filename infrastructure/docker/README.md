# Local Docker infrastructure

The local development containers are defined in the **repository-root**
`docker-compose.yml`, not in this directory. Keeping one compose file at the root
means `npm run infra:up` works from the root without extra flags or `-f` paths,
and keeps a single source of truth for service names, ports and volumes.

## Services

| Service    | Image                | Port | Purpose                                |
| ---------- | -------------------- | ---- | -------------------------------------- |
| `postgres` | `postgres:18-alpine` | 5432 | System of record for all business data |
| `redis`    | `redis:8-alpine`     | 6379 | BullMQ transport and coordination only |

Both services use named volumes (`truevine-postgres-data`,
`truevine-redis-data`) so data survives `docker compose down`, and both define
health checks so `docker compose up --wait` returns only once they are actually
accepting connections.

## Commands

```bash
npm run infra:up      # start and wait for health
npm run infra:ps      # status
npm run infra:logs    # tail logs
npm run infra:down    # stop, keep data
npm run infra:reset   # stop and DELETE all local data
```

## Adding a service

Only add a service here when local development genuinely requires it. Every new
service needs a health check and a named volume if it holds state; use a
placeholder password and never a real credential, because this file is
committed.
