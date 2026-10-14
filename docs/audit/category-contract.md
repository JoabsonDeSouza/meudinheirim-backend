# Category contract baseline

Recorded: 2026-10-13 · Feature: `recta-backend-adaptation` · Task: T10

## Existing storage invariants

- `prisma/schema.prisma` declares stable English `CategoryName` enum codes.
- `Transaction.categoryName`, `Budget.categoryName` and recurring category fields hold a system enum code or `CUSTOM:<uuid>` (schema comment at `prisma/schema.prisma:238`).
- Custom category rows have server UUID primary keys; transaction references encode those IDs as `CUSTOM:<uuid>` (`src/shared/utils/categoryHelpers.ts`).
- Display labels are supplied by app catalogs (`src/shared/enums/index.ts` retains legacy display helpers; v1 does not return those labels for system codes).

## T10 implementation

- `/v1/categories/system` returns `{ code, type }` only for system categories. It omits translated labels.
- `/v1/categories/` combines stable system codes with UUID-backed custom category codes; user-authored custom names remain unchanged.
- `/v1/categories/custom` creates custom records and returns `CUSTOM:<UUID>`.
- Runtime schemas reject unknown input fields.

## Migration decision

No database migration or seed is required for this baseline: system category codes already exist as stable enum values and custom category IDs already use UUIDs. Adding a second persisted `code` column would duplicate identity and create migration/backfill risk without changing the API guarantee. Existing rows remain unchanged. Integration evidence is in `tests/integration/category-codes.test.ts` and the security matrix test.

No SPEC_DEVIATION: the existing schema already satisfies the stable-ID storage decisions. The v1 API now exposes the contract explicitly.
