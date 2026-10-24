# Contacts, groups and CSV imports

All routes are under `/organizations/{organizationId}`. The organization must
come from the authenticated membership; a mismatched or inaccessible tenant
does not reveal whether a contact exists. Every route requires a session,
accepted terms and the permission shown below. Mutations also require the
existing CSRF cookie/header pair.

| Method and path | Permission | Purpose |
| --- | --- | --- |
| `GET /contacts?q=&groupId=&limit=&cursor=` | `contact:read` | Tenant-scoped search/list. `limit` is 1–100 (default 50); `q` searches phone, name and email and must contain at least two characters. |
| `POST /contacts` | `contact:create` | Create from `phone`, optional `name`, `email`, and up to 20 group names. |
| `PATCH /contacts/{contactId}` | `contact:update` | Update only `name` and `email`. Phone, consent and suppression are not editable here. |
| `DELETE /contacts/{contactId}` | `contact:update` | Delete a contact only when it is not suppressed and has no campaign-recipient history. Suppressed and history-referenced contacts return `409` and remain stored. |
| `POST /contacts/{contactId}/voice-consent` | `contact:update` | Record verified `voice_calling` consent evidence. Repeated consent is rejected; imported consent claims never grant consent. |
| `POST /contacts/{contactId}/suppress` | `contact:update` | Add durable suppression (`user_opt_out`, `operator_request`, `invalid_number`, or `other`). There is no suppression-clearing route. |
| `GET /contact-groups` | `contact:read` | List groups in the current organization. |
| `POST /contact-groups` | `contact:create` | Create a group. Names are unique case/spacing-insensitively within the organization. |
| `PATCH /contact-groups/{groupId}` | `contact:update` | Rename a group. |
| `DELETE /contact-groups/{groupId}` | `contact:update` | Delete a group and its memberships; contacts are retained. |
| `PUT /contact-groups/{groupId}/contacts/{contactId}` | `contact:update` | Add a tenant-local membership. Repeating the request is safe. |
| `DELETE /contact-groups/{groupId}/contacts/{contactId}` | `contact:update` | Remove a tenant-local membership. |
| `POST /contact-imports/preview` | `contact:import` | Validate a CSV batch and mapping without writing records. |
| `POST /contact-imports` | `contact:import` | Start an import with caller-supplied stable `importId` and `columnMapping`. |
| `POST /contact-imports/{importId}/batches` | `contact:import` | Process the next ordered batch: `{ "batchNumber": 0, "csv": "..." }`. |
| `POST /contact-imports/{importId}/complete` | `contact:import` | Complete the import after all batches. |
| `GET /contact-imports/{importId}` | `contact:read` | Read aggregate counts and row-number/code-only reports. |

CSV batches are limited to 256 KiB, 250 data rows, 20 columns, and 20 groups
per row. The phone column is required. Header aliases and explicit mapping are
supported for phone, name, email, groups, consent and suppression. Uganda local
numbers normalize to E.164; invalid values and duplicate normalized numbers
within a batch are reported by row number. Preview reports only row numbers,
actions, codes and aggregate counts; it does not echo CSV values. Import reports
never retain raw CSV or contact fields.

Batch processing is sequential and transactional. The same batch number and
payload hash return the persisted report; a changed payload or out-of-order
batch returns a conflict. Each import is bounded to 250 rows per request, so
processing remains synchronous and does not enqueue personal data into a
worker. PostgreSQL constraints enforce tenant-scoped keys, phone uniqueness,
and organization-matched group/contact membership.

Consent is not inferred from an imported “yes” value. An imported opt-out adds
suppression, and reimports, contact edits, or group membership cannot clear it.
The execution-eligibility query requires current explicit voice consent and
excludes suppressed contacts at query time. Campaign dispatch integration is
not provided by these contact endpoints.
