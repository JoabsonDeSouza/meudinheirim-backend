# Auth Sync Default Account Validation

**Date**: 2026-10-20
**Spec**: `.specs/features/auth-default-account/spec.md`
**Diff range**: `c10d56a4abfdd0c07aa3ff7cf63213266aabaa45..34a9bf435b718fee95c37a3ba23d7254912bc97b`
**Verifier**: independent verifier (author ≠ verifier)

## Validation: PASS

## Task Completion

| Task | Status | Evidence |
| --- | --- | --- |
| T1 | ✅ Done | `bootstrap.ts` wraps user, household, membership, and account writes in one Prisma transaction; integration cases cover zero values, both locales/currencies, idempotency, concurrency, preservation, and rollback. |
| T2 | ✅ Done | Route validates and documents sync input; integration tests assert the complete success envelope and preference persistence; contract test checks documented fields. |
| T3 | ✅ Done | Added full-table no-write/rollback counts, active status, exact record snapshots, exact top-level OpenAPI/Zod property parity, and full response envelope assertions. |

## Spec-Anchored Acceptance Criteria

| AC | Spec-defined outcome | `file:line` + exact assertion | Result |
| --- | --- | --- | --- |
| 1 | Accept only `pt-BR`/`en-US`, `BRL`/`USD`, and a valid IANA timezone. | `src/modules/auth/auth.schema.ts:17-24` — enums and timezone schema; `tests/integration/auth-sync.test.ts:55-88` — valid request returns 200; `tests/integration/bootstrap.test.ts:151-184` — both locale/currency combinations create accounts. | ✅ PASS |
| 2 | Missing/invalid required input returns 400 and creates no rows. | `tests/integration/auth-sync.test.ts:90-108` — each invalid request expects 400, then `databaseCounts()` equals the before snapshot. Helper `:26-34` snapshots users, households, memberships, and accounts. | ✅ PASS |
| 3 | New user, household, membership, and account are created atomically. | `tests/integration/auth-sync.test.ts:55-88` — checks response user ID/email, persisted Firebase UID/email, membership for that user and returned household, and one account. `tests/integration/bootstrap.test.ts:258-270` — injected account failure leaves all four counts zero. | ✅ PASS |
| 4 | A household with no accounts receives exactly one active CHECKING account, requested currency, and zero in every balance field. | `tests/integration/bootstrap.test.ts:151-168` — account list destructured from household; asserts `status: 'ACTIVE'`, type, currency, name, and four exact `0.00` balances. | ✅ PASS |
| 5 | `pt-BR` account name is `Conta principal`. | `tests/integration/bootstrap.test.ts:158-163` — exact name assertion. | ✅ PASS |
| 6 | `en-US` account name is `Main account`. | `tests/integration/bootstrap.test.ts:170-183` — exact name assertion. | ✅ PASS |
| 7 | Existing accounts and stored user preferences remain unchanged; no duplicate is created. | `tests/integration/bootstrap.test.ts:231-255` — one account remains; `accountSnapshot()` (helper `:91-95`) JSON-snapshots the entire Prisma account rows and compares exact equality; `userPreferences()` (`:96-106`) snapshots all preference fields and compares exact equality. | ✅ PASS |
| 8 | Repeated/concurrent requests succeed with one user, one household, and at most one account. | `tests/integration/bootstrap.test.ts:186-218` — retry returns same IDs and one account; three concurrent calls return one user ID/household ID and leave one membership/account. `tests/integration/auth-sync.test.ts:121-142` — three HTTP requests return 200, one household ID, one membership, and one account. | ✅ PASS |
| 9 | Any bootstrap write failure rolls back user, household, membership, and account. | `tests/integration/bootstrap.test.ts:258-270` — trigger makes account insert fail; `databaseCounts(email)` equals `{ users: 0, memberships: 0, households: 0, accounts: 0 }`. | ✅ PASS |
| 10 | Email linked to another UID returns conflict without changing either identity. | `tests/integration/auth-sync.test.ts:144-164` — expects 409, original UID remains, conflicting UID count is zero. | ✅ PASS |
| 11 | Missing authentication returns 401 and creates no data. | `tests/integration/auth-sync.test.ts:110-119` — expects 401 and all four global table counts remain equal to the before snapshot. | ✅ PASS |
| 12 | Account access from another household is denied. | `tests/integration/auth-sync.test.ts:166-188` — household IDs differ and cross-household request returns 403. | ✅ PASS |
| 13 | Preference OpenAPI documents the accepted fields; valid locale/currency persist. | `tests/contract/openapi-contract.test.ts:76-81` — sorted OpenAPI properties equal every key in `updateUserPreferencesSchema.shape`; `tests/integration/user-preferences.test.ts:26-53` — update and GET return USD/en-US; `:55-67` — EUR returns 400 and persisted currency/locale remain unchanged. | ✅ PASS |

## Discrimination Sensor

Five behavior mutations ran in `/private/tmp/authsync-final-sensor`, a detached scratch worktree. Each run reached feature assertions; each mutant was killed. The real worktree status was `?? .specs/features/auth-default-account/validation.md` before and after the sensor, and `git diff --check` passed.

| Mutation | Covering assertion | Result |
| --- | --- | --- |
| Force the wrong account label for both locales | `tests/integration/bootstrap.test.ts:158-163`, `:178-182` | ✅ Killed — both locale assertions failed. |
| Force BRL for all accounts | `tests/integration/bootstrap.test.ts:178-182` | ✅ Killed — USD assertion failed. |
| Initialize balances to 1 | `tests/integration/bootstrap.test.ts:164-167`, `:183` | ✅ Killed — zero-balance assertions failed. |
| Create account despite an existing account | `tests/integration/bootstrap.test.ts:203-218`, `:245-248` | ✅ Killed — concurrency and no-duplicate assertions failed. |
| Bypass the transaction wrapper | `tests/integration/bootstrap.test.ts:258-270` | ✅ Killed — rollback table-count assertion failed. |

**Sensor outcome**: 5/5 killed.
**Isolation**: scratch worktree removed; real worktree unchanged except this validation report.

## Code Quality

| Check | Result |
| --- | --- |
| Scope stays within requested backend work | ✅ Changed implementation and test files are backend only. |
| Existing behavior and household isolation are preserved | ✅ Conflict and cross-household tests pass. |
| Coverage traces each acceptance criterion to an assertion | ✅ 13/13 criteria have test evidence. |
| Existing account/preference rows are compared completely | ✅ Full account row snapshots and all preference fields are compared. |
| Formatting/whitespace | ✅ `git diff --check` passed. |

## Edge Cases

- [x] Missing locale, unsupported locale/currency, and invalid timezone return 400 without writes.
- [x] Existing household without accounts gets one default account.
- [x] Existing account with nonzero balances and preferences stays unchanged.
- [x] Concurrent sync creates one user, household, membership, and account.
- [x] Injected account insert failure rolls back all four table groups.
- [x] Conflicting Firebase UID/email is rejected without rebinding.
- [x] Unauthenticated request returns 401 without writes.
- [x] Cross-household account read returns 403.

## Gate Check

**Command**: `npm run lint && npm run typecheck && npm run test:unit && npm run test:integration && npm run test:contract && npm run build`
**Result**: all commands exited 0. Lint passed; typecheck passed; unit 72/72 (19 files); integration 61/61 (17 files); contract 6/6 (1 file); build passed. No skipped tests were reported. Counts match `tasks.md`.

## Grounded Failure Signal

The previous independent run found gaps because rejected requests and rollback only checked users/memberships, and account preservation checked selected fields. T3 now checks all four related table counts, snapshots every account field and every user preference field, and asserts the active account status. These were assertion coverage gaps; the current tests detect the corresponding behavior mutations.

**Overall**: ✅ Ready.
