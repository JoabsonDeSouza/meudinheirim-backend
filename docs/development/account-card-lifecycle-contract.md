# Account and credit-card lifecycle contract (V1)

All endpoints require Firebase bearer authentication. Account operations resolve household ownership from server-side membership; mutations require an editor role. Amounts and currencies remain explicit, and this API does not convert currency.

## Primary credit card

- `POST /v1/accounts/:accountId/primary-card` selects a primary card. No body is required. Returns `{success:true,data:<account>}`.
- Eligibility: account must belong to the caller's household, be active, and have type `CREDIT`. Primary status is unique per household and currency. Concurrent changes serialize; replacing a primary is atomic. A bank account or archived card returns `BAD_REQUEST`.
- Archiving the current primary clears its primary flag. The server does not select a replacement.

## Safe archival

- `POST /v1/accounts/:accountId/archive` has no request body and returns `{success:true,data:<account>}` when archived. It is idempotent for an already archived account.
- Archive preserves the account and all linked transactions/invoice records, sets it inactive, and clears primary status. An account cannot be archived while it has unpaid transactions (including transfer sides), an active recurring schedule, an open/closed unpaid card invoice, nonzero balance fields, or allocations. It returns `409 ACCOUNT_ARCHIVE_BLOCKED` when one or more blockers remain. Archive prevents future account selection/charges through active-account validation.
- `PATCH /v1/accounts/:accountId` cannot change account type or currency after creation. Setting only `isActive:false` uses the same safe archive behavior. Use the dedicated archive endpoint for clarity. Existing destructive `DELETE /v1/accounts/:accountId` is deprecated; clients must not use it.

## Financial boundaries

Creating an expense on a credit card records a purchase and its invoice entry; it is not an invoice payment. Invoice payments remain on the dedicated credit-card invoice endpoint and use an eligible bank account as `sourceAccountId`, with that flow's idempotency contract. Account edits are not a mechanism for setting balances or used credit limits as part of card creation/editing; those fields remain governed by existing ledger/payment rules.

## Stable errors

- `BAD_REQUEST` (400): account is not an eligible active credit card, or immutable type/currency was changed.
- `ACCOUNT_ARCHIVE_BLOCKED` (409): archive blockers exist. `error.message` identifies blocker codes: `PENDING_TRANSACTIONS`, `ACTIVE_RECURRING_SCHEDULES`, `UNPAID_INVOICES`, `NONZERO_BALANCE`, and/or `ALLOCATED_BALANCE`.
- `NOT_FOUND` (404): account is outside the household or does not exist.
- `FORBIDDEN`/`INSUFFICIENT_ROLE` (403): caller lacks household/editor permission.
