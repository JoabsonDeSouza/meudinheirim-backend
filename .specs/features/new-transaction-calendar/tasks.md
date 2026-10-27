# Execution tasks

1. [x] Confirm baseline, docs, and existing transaction/card/recurrence behavior; create isolated worktree from current `main`.
2. [x] Record product scope and unresolved money/date/invoice semantics without choosing a financial rule silently.
3. [x] Obtain decisions for installment cent distribution, date anchoring, and invoice-cycle assignment.
4. [ ] Confirm the 11 category labels/icons against the source screenshots from Mobile; blocked on screenshots, reuse existing stable system/custom codes meanwhile.
5. [x] Finalize endpoint/request/response/error/auth contract and tests before implementation.
6. [x] Implement, preserving old V1 transaction compatibility and atomic/idempotent semantics.
7. [x] Run disposable-DB-backed tests after verifying `TEST_DATABASE_URL`; lint, typecheck, affected tests, and CI gates pass.
8. [x] Update API contract docs and execution evidence; commit conventionally on this branch only.
9. [ ] Return branch/worktree/hash and reviewed contract to Orquestrador; do not merge, push, deploy, or remove worktree before review.
