# API documentation

REST API reference for product endpoints.

- [Contacts, groups and CSV import](./contacts.md)

## Conventions to adopt when the API grows

- Resource paths are plural nouns: `/organizations/{id}/contacts`.
- Every tenant-owned route carries the organization in the path or is resolved
  from the authenticated session; never from a client-supplied body field.
- Money is transported as integer minor units plus a currency code, never as a
  float.
- Every externally-visible mutating operation accepts an idempotency key.
- Errors use a consistent problem-details shape with a stable, documented
  `code`; error messages never leak internal details to clients.
