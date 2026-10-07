# @truevine/auth

Reserved for authentication, session management, authorization and RBAC.

**Status: intentionally empty.** No code exists here yet. Authentication and
RBAC are explicitly deferred; creating scaffolding now would presume decisions
(identity provider, session storage, permission model) that have not been
agreed.

Expected future contents:

- Identity provider integration behind an interface, never imported directly by
  other packages.
- Session issuance and validation.
- A permission model where every check is organization-scoped, so a permission
  can never be evaluated without a tenant context.

Until then, do not import `@truevine/auth` from anywhere: it exports nothing.
