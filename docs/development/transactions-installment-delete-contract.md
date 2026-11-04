# Installment group delete contract (V1)

Implements the mobile request: delete **one selected installment** OR **all remaining
installments of the same purchase** (past and future, regardless of pagination).
Additive on top of the existing `/v1` transaction contract; the legacy individual
delete is unchanged. Nothing here touches transfers, recurring series cancellation,
or installment-plan creation.

## Scope

- Plain expenses/income and installment purchases only. Recurring occurrences are
  not extended with a signed-cancellation semantic (see below).
- Server-side group selection: `householdId` + `installmentId`. The mobile never
  sends the target item list and must never infer the group from a page limited to
  `limit:100`; the preview endpoint returns the full group.

## Semantics after an individual delete (fixed)

Soft-deleting one installment (`DELETE .../:transactionId?...expectedVersion`) does
**not** mutate its siblings. Every surviving transaction of the same
`installmentId` keeps the ORIGINAL metadata:

- `installmentTotalAmount` = the original purchase total (e.g. R$ 100,01 for 4x R$ 25,01).
- `totalInstallments` = the original total count (e.g. 4).
- `installmentId` / `installmentNumber` unchanged.

There is NO renumbering. Display rule for the grouped identity (the row that today
represents the first installment):

- original purchase: `installmentTotalAmount` (per item) and `totalInstallments`;
- still-active footprint: `installment-summary` → `activeCount`, `active...` fields
  and `amounts` (sum of non-deleted items per currency);
- never derive "remaining" as `totalInstallments - deletedAt count` inside one
  API response; use the preview.

## Preview / confirmation of impact

`GET /v1/transactions/:transactionId/installment-summary?householdId=<uuid>`

200 response (exact):

```json
{
  "transactionId": "uuid",
  "installmentId": "uuid | null",
  "isInstallmentGroup": true,
  "installmentNumber": 2,          // n of the selected installment (null when not grouped)
  "totalInstallments": 4,          // N of the purchase (null when not grouped)
  "activeCount": 4,                // non-deleted items; closed invoices may still block the whole group
  "paidCount": 3,                  // of active, ones needing balance reversal
  "openInvoiceCount": 4,           // active transaction items attached to OPEN invoices (not distinct invoices)
  "groupToken": "64-char sha-256 hex", // snapshot token of the exact member set; changes on ANY group change
  "amounts": [{ "currency": "BRL", "minorUnits": 3000 }]
}
```

404 `Transaction` when missing or outside the household. For a non-installment
transaction, `isInstallmentGroup` is `false` and the snapshot describes the single
item (`activeCount: 1`). The confirmation dialog must use these numbers verbatim.
Submit the `groupToken` and count shown to the user. If either changes before the
delete, the server returns `409 INSTALLMENT_GROUP_CONFLICT`; fetch a new preview
and ask the user to confirm the changed impact. Never silently replace the token
or count after approval.

## Delete

`DELETE /v1/transactions/:transactionId`

- individual (unchanged): `?clientMutationId=<uuid>&expectedVersion=<int>` →
  200 `TransactionV1Dto`.
- group: `?clientMutationId=<uuid>&deleteScope=group&expectedGroupCount=<activeCount>&expectedGroupToken=<groupToken>`
  → 200:

```json
{
  "type": "INSTALLMENT_GROUP_DELETE",
  "scope": "group",
  "installmentId": "uuid",
  "deletedCount": 4,
  "deletedPaidCount": 3,
  "matchedGroupToken": "64-char sha-256 hex",
  "items": ["...TransactionV1Dto, one per deleted item..."]
}
```

### Block and conflict codes

| Situation | Status | Code |
| --- | --- | --- |
| Group contains an item whose invoice is CLOSED | 400 | `BAD_REQUEST`, message `Cannot delete the installment group: X closed invoice(s) block Y of N transactions` (X = distinct closed invoices, Y = blocked transactions — never mixed with the transaction counts) |
| `deleteScope=group` without `expectedGroupCount`/`expectedGroupToken` | 400 | `BAD_REQUEST` |
| Transaction has no `installmentId` and `deleteScope=group` | 400 | `BAD_REQUEST` (`not an installment purchase`) |
| Individual delete without `expectedVersion` | 400 | `BAD_REQUEST` |
| Missing/foreign transaction | 404 | `NOT_FOUND` |
| Group changed (set, counts, versions, timestamps or values) since confirmation | 409 | `INSTALLMENT_GROUP_CONFLICT` |
| Row concurrently version-bumped inside the atomic window | 409 | `VERSION_CONFLICT` |
| Same `clientMutationId` with different delete payload | 409 | `IDEMPOTENCY_CONFLICT` (differs = must use a new id) |

Replay: repeating the exact same `clientMutationId` returns the stored 200 response
with no additional effects.

The group delete is atomic (row locks `FOR UPDATE` on all group rows), rejects the
whole group when any item is not deletable, and never deletes a partial subset.
Balance and invoice total reversals are applied per item after locks are acquired
in this order: invoice lifecycle IDs sorted, account IDs sorted, then transaction
rows sorted by ID. One group-level mutation receipt is saved; one sync change is
emitted for each deleted transaction.

Invoice lifecycle coordination: group delete, individual edit, and individual
delete acquire the same `pg_advisory_xact_lock(invoice-lifecycle:<invoiceId>)`
lock used by invoice close/pay/refund. They re-read invoice status only after
holding the lock. Edit/delete acquire invoice locks before account locks, then
transaction-row writes, matching the shared order. An existing destination
invoice for a moved transaction is locked before mutation too. A concurrent
invoice closure therefore happens strictly before or after the operation; when
closure wins, the edit/delete is rejected without partial balance or total
changes. Deterministic concurrency tests live in
`tests/integration/transactions-installment-group-v1.test.ts`.

No re-creation of deleted installments: `POST /v1/transactions/plans` with
`INSTALLMENTS` materializes every installment at creation and persists only the
mutation receipt (`SyncMutation`, entity `transaction_plan`); there is no
persistent installment-plan row. The recurring cron job
(`src/jobs/processRecurrences.ts`) touches `RecurringTransaction` rows only, so
deletions are never regenerated.

## Unpaid installments and edit separation

Unpaid items (`paid: false`) are deletable; `paidCount` tells the client how many
balance reversals will occur. Remove is a separate action from edit; a paid group
member can be removed without any edit payload.

## Recurring series are not cancelled implicitly

Deleting the transaction of a recurring occurrence (individual or, mistakenly,
`deleteScope=group` — occurrences have no `installmentId`, so the group scope
rejects them) removes only that materialized transaction. The recurring
transaction/série remains active; cancellation must go through the
recurring-transactions API explicitly.
