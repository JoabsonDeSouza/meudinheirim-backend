# New transaction and calendar API

## Goal

Extend the versioned transaction API for a purchase entered as a total with 2–6 monthly card installments, and for a monthly continuous recurring transaction whose first occurrence is the transaction being created. Preserve the existing single-transaction API behavior and make related writes atomic/idempotent.

## Existing contract and data rules

- `POST /v1/transactions` uses strict Zod input, Firebase auth, household editor authorization, integer minor-unit `MoneyDto`, mutation receipts, and transaction/account/invoice/sync updates in one Prisma transaction.
- Credit-card purchases are assigned by the existing billing-cycle calculation using the occurrence instant/time zone and card `closingDay`/`dueDay`. A purchase records a charge; it does not pay the invoice (`docs/development/account-card-lifecycle-contract.md`).
- Monthly recurring dates already retain `anchorDay`; days 29–31 clamp to the last day of a shorter month and resume the anchor in later months (`docs/development/recurring-fixed-expenses-contract.md`).
- The database already has `installmentId`, `installmentNumber`, and `totalInstallments`; V1 creation currently does not write them. Confirm whether those fields are sufficient for the client contract before introducing a migration.
- Existing system category identity is stable enum codes; labels/icons are app-owned (`docs/audit/category-contract.md`). Do not invent a new 11-item catalog or enum names before Mobile supplies the referenced screenshots/source.

## Proposed scope

- Additive V1 contract for a planned transaction with mutually exclusive installment and recurring options; legacy single transaction requests stay unchanged.
- Installment flow is expense-only, credit-card-only, accepts the purchase total, and emits 2–6 monthly transaction rows that sum exactly to the supplied total.
- Recurring flow is monthly/continuous and supports expense or income categories; the entered transaction is occurrence one, the recurring rule starts with that occurrence, and the next run is the next monthly anchor date. Persist the occurrence link/marker atomically so the scheduler cannot create a duplicate. Installments remain expense-only.
- Installments and recurrence cannot be combined. Bank/debit accounts cannot have installment count. Card purchase does not settle an invoice.
- Catalog work may expose existing stable codes only until the 11 category names/icons are supplied and verified.
- Calendar reads use existing `GET /v1/transactions` date filtering plus `GET /v1/recurring-transactions/occurrences`; avoid changing the shipped transaction DTO until Mobile/orchestrator confirms it can consume additive fields.

## Confirmed product decisions

1. Allocate `totalMinorUnits % installmentCount` by adding one minor unit to each earliest installment until the remainder is exhausted.
2. Use the existing recurring date anchor rule for installments too: clamp the original day 29–31 to month end, then resume the original anchor (e.g. Jan 31 → Feb 28/29 → Mar 31).
3. Treat each installment as a separate purchase occurrence and assign it through the existing card billing-cycle function; invoice due date remains the card cycle's existing computed due date, and no invoice is paid by creation.

## Acceptance gates

- Strict request and OpenAPI schema stay aligned; old transaction requests remain compatible.
- Unit coverage for exact installment allocation and date expansion; integration coverage for cash/card eligibility, 2–6 installments, total conservation, invoice assignment, recurrence first-occurrence deduplication, invalid combinations, idempotency/concurrency, rollback, and auth/membership.
- Disposable test database only for integration/migrations. No development DB migration.
- Lint, typecheck, affected tests; for any schema/migration change, all CI gates plus reviewed SQL and `npm run db:generate`.
- Final reviewed contract documents endpoint, request/response, stable errors, and auth. Keep this branch unmerged/unpublished until orchestrator review.
