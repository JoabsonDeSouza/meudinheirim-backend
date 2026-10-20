# Auth Sync Default Account Tasks

## Execution Protocol

Use `tlc-spec-driven` Execute flow. One task per commit after its gate passes.

**Status**: In Progress

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

`T1 → T2`

## Task Breakdown

### T1: Add atomic account bootstrap

**What**: Create/find authenticated user and personal household and ensure one zeroed default checking account in one PostgreSQL transaction.
**Where**: `src/shared/auth/bootstrap.ts`
**Depends on**: None
**Requirement**: BOOT-01, BOOT-02, BOOT-03, BOOT-04, BOOT-05
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

**What**: Validate and document locale, base currency, timezone, and optional referral code; wire HTTP sync to transactional bootstrap.
**Where**: `src/modules/auth/auth.routes.ts`
**Depends on**: T1
**Requirement**: AUTH-01, AUTH-02, AUTH-03, AUTH-04
**Done when**:
- [ ] Valid sync returns existing response envelope and household ID.
- [ ] Invalid payload, unauthenticated request, identity conflict, and cross-household access have precise HTTP tests.
- [ ] OpenAPI contract lists required fields and existing auth/finance endpoints remain documented.
- [ ] Gate `npm run test:unit && npm run test:integration && npm run test:contract` passes.
**Tests**: integration, contract
**Gate**: full
**Commit**: `feat(auth): validate sync locale currency and timezone`

## Phase Execution Map

`Phase 1: T1 → Phase 2: T2`
