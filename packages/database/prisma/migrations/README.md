# Database migrations

Prisma stores one folder per migration in this directory.

There are **no migrations yet** — the foundation stage deliberately creates no
tables. The first migration will be produced by a later task, once the
tenant-scoped domain model is designed:

```
npm run prisma:migrate:dev -- --name <descriptive_name>
```

Rules that apply to every migration in this repository:

- Never hand-edit an already-applied migration. Add a new one instead.
- Never reset or drop a database that holds data you did not create.
- Review the generated SQL before applying it anywhere that is not disposable.
- Schema changes must remain backward compatible with the currently deployed
  application version (expand/contract), so that deploys and migrations can
  happen independently.
