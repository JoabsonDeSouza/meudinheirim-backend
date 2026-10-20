# Auth Sync Default Account Specification

## Problem Statement

`POST /v1/auth/sync` creates or finds the authenticated user and personal household, but does not ensure a financial account exists. A new frontend session therefore has no account for the first transaction. Sync must create one zeroed checking account atomically and safely.

## Goals

- [ ] Bootstrap one default checking account when the personal household has no accounts.
- [ ] Accept and validate locale, base currency, and timezone in the sync request.
- [ ] Preserve existing financial data, authentication, and household isolation.

## Out of Scope

| Feature | Reason |
| --- | --- |
| Frontend changes | Request limits this execution to backend. |
| Persisting timezone preference | User asked for request validation; user model has no timezone field. |
| Changing existing accounts or balances | Bootstrap must preserve them. |
| Push, merge, deploy | Explicitly excluded. |

## Assumptions & Open Questions

| Assumption / decision | Chosen default | Rationale | Confirmed? |
| --- | --- | --- | --- |
| Missing account definition | Household has zero account rows of any type/status. | User says a household with one or more accounts must not receive a duplicate. | Yes |
| Existing user preferences | Do not overwrite locale or currency on existing users. | User forbids modifying existing data; request values govern only a newly created account. | Yes |
| Timezone persistence | Validate as an IANA timezone but do not persist it. | No user timezone field exists and persistence was not requested. | Yes |
| Email linked to another Firebase UID | Return conflict; never rebind identity in auth sync. | Prevent identity takeover and preserve account isolation. | Yes |

**Open questions:** none.

## User Stories

### P1: Initialize finance account after authentication ⭐ MVP

**User Story**: As an authenticated user, I want sync to prepare my personal household with a default account so that I can use financial features immediately.

**Why P1**: New users need an account before creating a transaction.

**Acceptance Criteria**:

1. WHEN valid sync request is authenticated THEN the system SHALL accept `locale` (`pt-BR` or `en-US`), `baseCurrency` (`BRL` or `USD`), and a valid IANA `timeZone`.
2. IF any required field is missing or invalid THEN the system SHALL reject the request with HTTP 400 and create no data.
3. WHEN the authenticated user has no database record THEN the system SHALL create the user and personal household in the same transaction as account bootstrap.
4. WHEN the personal household has no account THEN the system SHALL create exactly one active `CHECKING` account with zero balance fields and the requested currency.
5. WHEN locale is `pt-BR` THEN the system SHALL name the new account `Conta principal`.
6. WHEN locale is `en-US` THEN the system SHALL name the new account `Main account`.
7. WHEN the household already has one or more accounts THEN the system SHALL create no account and SHALL preserve every existing account field and user preference.
8. WHEN repeated or concurrent sync requests use the same identity THEN the system SHALL return success with one user, one personal household, and at most one bootstrap account.
9. IF any bootstrap write fails THEN the system SHALL roll back user, household, membership, and account writes.
10. IF a verified Firebase identity has an email linked to a different UID THEN the system SHALL reject sync without changing either identity.
11. IF a request is unauthenticated THEN the system SHALL return HTTP 401 and create no data.
12. IF an authenticated user requests another household's account data THEN the system SHALL deny access.
13. WHEN clients read the user-preferences contract THEN the system SHALL document the same preference fields accepted by validation and SHALL persist valid locale and base currency updates.

**Independent Test**: Call sync with valid Firebase test identity and inspect persisted user, household, membership, and account rows; repeat concurrently and verify one account.

## Edge Cases

- Invalid locale, currency, empty timezone, and unsupported timezone.
- Existing user without household/account.
- Existing household containing an account with nonzero balances.
- Database failure at account insert.
- Concurrent sync requests.
- Email conflict across Firebase UIDs.

## Requirement Traceability

| Requirement ID | Story | Phase | Status |
| --- | --- | --- | --- |
| AUTH-01 | P1: Initialize finance account after authentication | Execute | Verified |
| AUTH-02 | P1: Initialize finance account after authentication | Execute | Verified |
| BOOT-01 | P1: Initialize finance account after authentication | Execute | Verified |
| BOOT-02 | P1: Initialize finance account after authentication | Execute | Verified |
| BOOT-03 | P1: Initialize finance account after authentication | Execute | Verified |
| BOOT-04 | P1: Initialize finance account after authentication | Execute | Verified |
| BOOT-05 | P1: Initialize finance account after authentication | Execute | Verified |
| BOOT-06 | P1: Initialize finance account after authentication | Execute | Verified |
| BOOT-07 | P1: Initialize finance account after authentication | Execute | Verified |
| AUTH-03 | P1: Initialize finance account after authentication | Execute | Verified |
| AUTH-04 | P1: Initialize finance account after authentication | Execute | Verified |
| AUTH-05 | P1: Initialize finance account after authentication | Execute | Verified |
| API-01 | P1: Initialize finance account after authentication | Execute | Verified |

**Coverage:** 13 requirements, 13 mapped to tasks, 0 unmapped.

## Success Criteria

- [ ] Integration tests prove localized default account creation, idempotency, concurrency, rollback, invalid payload, authentication, isolation, and preservation.
- [ ] Lint, typecheck, unit, integration, contract, and build commands pass.
- [ ] Existing endpoint contracts remain covered by current route/OpenAPI/integration suites.
