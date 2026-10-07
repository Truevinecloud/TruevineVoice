# @truevine/payments

Reserved for payment provider integration and the money-movement lifecycle.

**Status: intentionally empty.** Payments and billing are explicitly deferred.

Rules for this package once it is populated:

- **Money is never a JavaScript floating-point number.** Amounts are integer
  minor units or an exact decimal, always paired with a currency code.
- **Wallet accounting is an immutable ledger.** Balances are derived by summing
  entries. Entries are only ever appended; nothing is updated or deleted, and
  corrections are made with compensating entries.
- Every charge against a customer balance requires an idempotency key, and the
  key must be unique per operation so that a retry cannot double-spend.
- Provider SDK usage stays inside `adapters/`; nothing else imports it.
