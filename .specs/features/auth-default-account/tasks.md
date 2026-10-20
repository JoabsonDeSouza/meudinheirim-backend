# Auth Sync Default Account Tasks

## Execution Protocol

Use `tlc-spec-driven` Execute flow. One task per commit after its gate passes.

**Status**: Done

## Test Coverage Matrix

| Code layer | Coverage required |
| --- | --- |
| Bootstrap service | Integration tests against disposable PostgreSQL for idempotency, concurrency, zero values, preservation, and rollback. |
| HTTP route | HTTP integration tests for request validation, authentication, conflict, and household isolation. |
| OpenAPI contract | Contract test for documented request fields and required list. |

## Gate Check Commands

- Quick: `npm run test:integration -- --testNamePattern='auth sync|user/personal-household bootstrap'`
- Full: `npm run test:unit && npm run test:integration && npm run test:contract`
- Final: `npm run lint && npm run typecheck && npm run test:unit && npm run test:integration && npm run test:contract && npm run build`

## Execution Plan

### Phase 1: Transactional bootstrap

`T1`

### Phase 2: HTTP contract and end-to-end behavior

`T1 → T2 → T3`

## Task Breakdown

### T1: Add atomic account bootstrap

**What**: Create/find authenticated user and personal household and ensure one zeroed default checking account in one PostgreSQL transaction.
**Where**: `src/shared/auth/bootstrap.ts`
**Depends on**: None
**Requirement**: BOOT-01, BOOT-02, BOOT-03, BOOT-04, BOOT-05, BOOT-06, BOOT-07
**Done when**:
- [x] User, household membership, and account creation share one transaction.
- [x] Advisory locks serialize syncs for the Firebase UID and email.
- [x] Existing account and preference values remain unchanged.
- [x] Bootstrap integration tests cover locale/currency, existing data, idempotency, concurrency, and rollback.
- [x] Gate `npm run test:integration -- --testNamePattern='auth sync|user/personal-household bootstrap'` passes (10 passed).
**Tests**: integration
**Gate**: quick
**Commit**: `feat(auth): bootstrap default account during sync`

### T2: Expose strict sync request contract

**What**: Validate and document auth sync fields, wire HTTP sync to transactional bootstrap, and align preferences OpenAPI schema with its Zod contract.
**Where**: `src/modules/auth/auth.routes.ts`
**Depends on**: T1
**Requirement**: AUTH-01, AUTH-02, AUTH-03, AUTH-04, AUTH-05, API-01
**Done when**:
- [x] Valid sync returns existing response envelope and household ID.
- [x] Invalid payload, unauthenticated request, identity conflict, and cross-household access have precise HTTP tests.
- [x] OpenAPI contract lists required sync fields and accurately documents preferences.
- [x] Preference HTTP tests prove valid locale/currency persistence and invalid currency rejection.
- [x] Existing account, category, transaction, transfer, invoice, dashboard, recent transaction, insight, budget, preferences, and sync contracts pass current suites.
- [x] Gate `npm run test:unit && npm run test:integration && npm run test:contract` passes (72 unit, 61 integration, 6 contract tests).
**Tests**: integration, contract
**Gate**: full
**Commit**: `feat(auth): validate sync locale currency and timezone`

### T3: Close validation coverage gaps

**What**: Assert complete no-write and rollback outcomes, account status, preservation of complete existing records, exact OpenAPI/Zod field parity, and the full HTTP response envelope.
**Where**: `tests/integration/bootstrap.test.ts`, `tests/integration/auth-sync.test.ts`, `tests/contract/openapi-contract.test.ts`
**Depends on**: T1, T2
**Requirement**: BOOT-02, BOOT-04, BOOT-06, AUTH-01, AUTH-02, API-01
**Done when**:
- [x] Invalid and unauthenticated requests leave user, household, membership, and account counts unchanged.
- [x] Successful sync asserts the user, membership, full response envelope, and active account status.
- [x] Injected account failure leaves no user, household, membership, or account rows.
- [x] Existing account and user preference snapshots are exactly unchanged after repeated sync.
- [x] OpenAPI preference properties exactly match the Zod schema keys.
- [x] Full final gate passes.
**Tests**: integration, contract
**Gate**: full
**Commit**: `test(auth): strengthen bootstrap contract assertions`

## Phase Execution Map

`Phase 1: T1 → Phase 2: T2 → Phase 3: T3`
