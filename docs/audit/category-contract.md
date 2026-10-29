# Category contract baseline

Recorded: 2026-10-13 · Feature: `meudinheirim-backend-adaptation` · Task: T10

## Existing storage invariants

- `prisma/schema.prisma` declares stable English `CategoryName` enum codes.
- `Transaction.categoryName`, `Budget.categoryName` and recurring category fields hold a system enum code or `CUSTOM:<uuid>` (schema comment at `prisma/schema.prisma:238`).
- Custom category rows have server UUID primary keys; transaction references encode those IDs as `CUSTOM:<uuid>` (`src/shared/utils/categoryHelpers.ts`).
- Display labels are supplied by app catalogs (`src/shared/enums/index.ts` retains legacy display helpers; v1 does not return those labels for system codes).

## T10 implementation

- `/v1/categories/system` returns `{ code, type }` only for system categories. It omits translated labels.
- `/v1/categories/` combines stable system codes with UUID-backed custom category codes; user-authored custom names remain unchanged.
- `/v1/categories/custom` creates custom records and returns `CUSTOM:<UUID>`.
- `POST /v1/categories/:categoryId/archive` idempotently sets `archived_at` for a custom category and returns `{ success: true, data: { id, archivedAt } }`. It requires Firebase auth and household editor access; system categories cannot be addressed because the path requires a UUID. Default category listing omits archived custom categories. Existing transaction, budget, and recurring references are retained; new transaction creation and new/changed recurring assignments reject archived custom categories. Existing recurring rules continue generating occurrences with their archived `CUSTOM:<UUID>` reference; editors can change the rule to an active category. Historical transaction DTOs retain the stable code.
- Archive returns `NOT_FOUND` when the custom category does not exist or is outside the caller's household, and `FORBIDDEN`/`INSUFFICIENT_ROLE` when the caller lacks editor permission. Repeated archive calls return the original `archivedAt` timestamp.
- Runtime schemas reject unknown input fields.

## Migration decision

No database migration or seed is required for this baseline: system category codes already exist as stable enum values and custom category IDs already use UUIDs. Adding a second persisted `code` column would duplicate identity and create migration/backfill risk without changing the API guarantee. Existing rows remain unchanged. Integration evidence is in `tests/integration/category-codes.test.ts` and the security matrix test.

No SPEC_DEVIATION: the existing schema already satisfies the stable-ID storage decisions. The v1 API now exposes the contract explicitly.
