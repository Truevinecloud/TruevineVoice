# API documentation

Reserved for the REST API reference.

**Status: intentionally empty.** The API currently exposes exactly one
endpoint, documented in the [root README](../../README.md). OpenAPI generation
and endpoint-by-endpoint reference material are explicitly deferred until the
first product endpoints exist.

## Conventions to adopt when the API grows

- Resource paths are plural nouns: `/organizations/{id}/contacts`.
- Every tenant-owned route carries the organization in the path or is resolved
  from the authenticated session; never from a client-supplied body field.
- Money is transported as integer minor units plus a currency code, never as a
  float.
- Every externally-visible mutating operation accepts an idempotency key.
- Errors use a consistent problem-details shape with a stable, documented
  `code`; error messages never leak internal details to clients.
