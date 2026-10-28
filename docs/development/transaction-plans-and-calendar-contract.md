# Transaction plans and calendar contract (V1)

## Scope and compatibility

`POST /v1/transactions` is unchanged. Planned creation is additive at `POST /v1/transactions/plans`. Existing transaction list and recurring occurrence endpoints remain the calendar read surfaces; this change does not introduce a new calendar-specific read route. All money is integer minor units with an explicit `BRL` or `USD` currency and no conversion.

System category codes remain the existing stable backend enum codes; names/icons for the separate 11-category mobile catalog are intentionally not specified pending the source screenshots. Callers continue to send `categoryCode` as the existing system code or household custom code.

## Authentication and authorization

Every request requires a Firebase bearer token. If `householdId` is omitted, the existing personal-household resolver applies. If supplied, the authenticated user must be an editor of that household to create a plan. The server validates account ownership, active status, account currency, and (for installments) credit-card type; household/account ownership is never accepted from a body field without membership checks.

## Create a plan

`POST /v1/transactions/plans`

Common request fields:

```json
{
  "householdId": "optional UUID",
  "clientMutationId": "UUID",
  "kind": "expense",
  "totalAmount": { "minorUnits": 10001, "currency": "BRL" },
  "categoryCode": "FOOD",
  "accountId": "UUID",
  "occurredAt": "2026-01-31T12:00:00.000Z",
  "timeZone": "America/Sao_Paulo",
  "note": "optional, max 255 chars",
  "paid": false,
  "plan": { "type": "INSTALLMENTS", "count": 4 }
}
```

`kind` is `expense` or `income`; `categoryCode` must match the selected kind using the existing category rules. `totalAmount.minorUnits` must be positive and contain at least one minor unit per installment. `plan` is exactly one of:

- `{ "type": "INSTALLMENTS", "count": 2..24 }`: expense-only; account must be an active credit card. The total is divided as evenly as possible; remaining minor units are assigned one each to the earliest installments (e.g. 10001/4 => 2501, 2500, 2500, 2500). Rows sum exactly to the input total. `totalAmount.minorUnits` must cover at least one minor unit per installment. The response contains exactly `count` items numbered 1 through `count`. Occurrence one uses the civil date of `occurredAt` in `timeZone`. Later dates use that original local day anchor and wall-clock time; days 29–31 clamp to month-end and resume the original day in later months. Each returned `occurredAt` is normalized to an ISO UTC instant.
- `{ "type": "RECURRING_MONTHLY" }`: accepts an expense or income category, and the account may be any active account. Creates an `ALWAYS` monthly schedule and the submitted expense/income transaction as occurrence one, atomically. `startDate` and `lastRunDate` use the first civil date of `occurredAt` in `timeZone`; `nextRunAt` is the next monthly anchor date. The initial occurrence link uses that same local civil date, avoiding UTC-offset day drift; recurring transaction instants are still stored as UTC timestamps. The existing recurring occurrence uniqueness/link behavior prevents scheduler duplication. The legacy occurrence payment route remains expense-only; receipt of a recurring income is not represented as an expense payment.

The two modes are mutually exclusive by the strict discriminated request schema. Income installments and installments on non-credit accounts are not supported. Credit-card installment rows each pass through the existing billing-cycle assignment logic using the plan's transaction date/time and time zone. Each row is a charge, not an invoice payment; invoice settlement remains a separate lifecycle operation. Existing card closing/due-day clamping is unchanged.

### Installment response (201)

```json
{
  "type": "INSTALLMENTS",
  "installmentId": "UUID shared by the group",
  "totalAmount": { "minorUnits": 10001, "currency": "BRL" },
  "installmentCount": 4,
  "items": [
    {
      "id": "UUID",
      "kind": "expense",
      "amount": { "minorUnits": 2501, "currency": "BRL" },
      "categoryCode": "FOOD",
      "accountId": "UUID",
      "invoiceId": "UUID",
      "occurredAt": "2026-01-31T12:00:00.000Z",
      "timeZone": "America/Sao_Paulo",
      "note": null,
      "paid": false,
      "createdAt": "ISO-8601",
      "updatedAt": "ISO-8601",
      "deletedAt": null,
      "version": 1,
      "clientMutationId": "UUID",
      "installmentId": "UUID shared by the group",
      "installmentNumber": 1,
      "totalInstallments": 4
    }
  ]
}
```

`items` contains one row per installment with the normal transaction DTO plus `installmentId`, `installmentNumber` (1-based), and `totalInstallments`. Every credit purchase has an `invoiceId` assigned by the current card lifecycle. Each row is persisted and sync-published in the same DB transaction.

### Recurring response (201)

```json
{
  "type": "RECURRING_MONTHLY",
  "recurringTransaction": {
    "id": "UUID",
    "accountId": "UUID",
    "categoryCode": "FOOD",
    "amount": { "minorUnits": 10001, "currency": "BRL" },
    "description": "optional note",
    "frequency": "MONTHLY",
    "startDate": "2026-01-31",
    "endDate": null,
    "nextRunAt": "2026-02-28",
    "lastRunDate": "2026-01-31",
    "timeZone": "America/Sao_Paulo",
    "isActive": true,
    "kind": "FIXED",
    "recurrenceMode": "ALWAYS",
    "occurrencesLimit": null,
    "anchorDay": 31
  },
  "firstOccurrence": { "id": "UUID", "kind": "expense", "amount": { "minorUnits": 10001, "currency": "BRL" } }
}
```

`firstOccurrence` is the standard transaction DTO. Recurrence and first transaction/occurrence linkage, sync changes, and idempotency receipt are atomic.

## Errors

Errors use `{ "success": false, "error": { "code", "message", "requestId" } }`:

- `401 UNAUTHORIZED`, `INVALID_TOKEN`, `EMAIL_NOT_VERIFIED`: missing/invalid Firebase auth.
- `403 FORBIDDEN`, `INSUFFICIENT_ROLE`: caller is not a member/editor for the household.
- `400 VALIDATION_ERROR`: malformed or strict-schema-invalid body.
- `400 BAD_REQUEST`: inactive/missing account, currency mismatch, unsupported account kind for installments, or closed invoice cycle.
- `404 NOT_FOUND`: referenced account/category/household resource is unavailable.
- `409 IDEMPOTENCY_CONFLICT`: `clientMutationId` reused with a different request body.
- `429 RATE_LIMIT_EXCEEDED`: request limit reached.

Creation is idempotent on `(authenticated user, clientMutationId)` and serialized for concurrent duplicate requests. The same ID with the same payload returns the original response; a changed payload conflicts. Related database writes roll back together on failure.

## Calendar reads

- `GET /v1/transactions` is the authoritative persisted transaction list; supports `occurredAfter` and `occurredBefore` ISO date-time filters, `householdId`, account/category/kind filters, and cursor pagination. Requires Firebase auth and household membership.
- `GET /v1/recurring-transactions/occurrences` expands managed recurring schedules over a civil date range, including the transaction linked to the first occurrence. Requires Firebase auth and household membership.

## Persistence and verification

Existing `Transaction.installmentId`, `installmentNumber`, and `totalInstallments` columns are reused; no Prisma migration is needed. Test evidence and remaining category-catalog dependency are tracked in `.specs/features/new-transaction-calendar/`.
