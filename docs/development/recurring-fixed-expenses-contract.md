# Fixed and variable recurring expenses (V1)

The existing `/v1/recurring-transactions` list/create DTO remains unchanged for compatibility. Managed schedules use the additive `/managed` subresource. All monetary values are integer minor units with explicit BRL/USD currency; totals are grouped per currency.

## Authentication and authorization

Every path below requires a Firebase bearer token. Household-scoped reads require household membership; create/edit/cancel/pay require an editor role. The server resolves household membership and account ownership; callers cannot set server-managed status or transaction identifiers.

## Endpoints

- `POST /v1/recurring-transactions/managed`: create a schedule. Request includes `accountId`, `categoryCode`, `amount: {minorUnits,currency}`, `frequency`, `startDate`, `timeZone`, optional `description`, `kind: FIXED|VARIABLE`, `recurrenceMode: ONCE|LIMITED|ALWAYS`, optional positive `occurrencesLimit` (1–1200), and optional inclusive `endDate`. `ONCE` counts the initial occurrence. `LIMITED` requires a count and/or end date. `ALWAYS` cannot have either bound. If mode is omitted, an end date means LIMITED; otherwise ALWAYS. `kind` defaults to FIXED.
- `GET /v1/recurring-transactions/managed?householdId=...`: `{items: RecurringManagedDto[]}`.
- `GET /v1/recurring-transactions/occurrences?householdId=...&from=YYYY-MM-DD&to=YYYY-MM-DD`: expands schedules over a maximum 366-day inclusive range. Returns `{items,totalsByCurrency}`. Item status is `PAID`, `PENDING` (materialized unpaid, not overdue), `OVERDUE` (past and unpaid), or `SCHEDULED` (future, not materialized). Amounts are MoneyDto; variable unpaid amounts are explicitly `isEstimate: true`. Each currency total has total, paid, remaining, estimated minor units, and rounded paid percentage.
- `PATCH /v1/recurring-transactions/:recurringId?householdId=...`: strict partial edits to `accountId`, `categoryCode`, `amount`, `description`, `frequency`, `kind`, `recurrenceMode`, `occurrencesLimit`, `endDate`, and `timeZone`. `accountId` applies to future occurrences and must identify an active same-household account in the schedule currency. Pending materialized occurrences are moved only when both their existing and target accounts are bank accounts; the account and transaction update is atomic. If either side is a credit card, the edit returns `409 RECURRING_OCCURRENCE_ACCOUNT_CONFLICT`. Paid transaction records are not rewritten.
- `DELETE /v1/recurring-transactions/:recurringId?householdId=...`: stops future occurrences and records a cancellation date; past transactions remain unchanged.
- `POST /v1/recurring-transactions/:recurringId/occurrences/:occurrenceDate/pay`: request `{householdId?, accountId?, amount: MoneyDto, clientMutationId}`. Fixed schedules require the base amount. Variable schedules accept the actual amount for this occurrence only. Optional `accountId` selects an active same-household, same-currency account for this occurrence. Response `{recurringTransactionId,date,transactionId,accountId,status:"PAID",amount,replayed}`. Payment updates an existing pending cron-created transaction or creates an occurrence transaction; the occurrence marker/advisory lock and mutation receipt prevent duplicates. A card account records a card purchase and creates/updates its invoice entry; it does not pay the invoice. Invoice settlement remains a separate credit-card invoice flow using a bank-account source.

## Date and cron rules

Dates are UTC civil dates and `endDate` is inclusive. Monthly/yearly schedules use a persisted day anchor: day 29–31 clamps to the target month's last day and resumes the original anchor afterward. The scheduler creates pending transactions only; cron execution is not payment. This rule also applies to the next occurrences of schedules that already existed before this release: credit-card occurrences previously auto-marked paid by cron will now be pending until an explicit pay action. Existing transactions and account balances are not rewritten or recalculated by migration; only future cron occurrences use the new rule. Occurrence count includes `startDate`; the schedule deactivates after its count/end date. Existing rows backfill as FIXED and ALWAYS when no end date, or LIMITED when they have an end date.

## Stable errors

Common error envelope codes: `UNAUTHORIZED`/`INVALID_TOKEN` (401), `FORBIDDEN`/`INSUFFICIENT_ROLE` (403), `NOT_FOUND` (404), `VALIDATION_ERROR` or `BAD_REQUEST` (400), `VERSION_CONFLICT`/`IDEMPOTENCY_CONFLICT` (409), and unexpected `INTERNAL_ERROR` (500). Currency/account mismatch and invalid schedule bounds use `BAD_REQUEST`.

Occurrence account changes that would move an existing materialized transaction to or from a card use `RECURRING_OCCURRENCE_ACCOUNT_CONFLICT` (409); they never rewrite card invoice history as a bank payment. A paid occurrence cannot be retargeted.
