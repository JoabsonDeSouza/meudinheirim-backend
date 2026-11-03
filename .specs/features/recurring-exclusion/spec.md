# Recurring occurrence exclusion

## Problem Statement

The managed recurring API only cancels a whole schedule. It cannot exclude one selected due date or distinguish an inclusive from an exclusive future cutoff. Hiding an already materialized pending occurrence without deleting its transaction would leave inconsistent ledger and invoice state.

## Out of Scope

- Mobile UI changes, transaction reversal for paid history, remote deployment, and development or production database migration.

## Assumptions & Open Questions

- The selected `occurrenceDate` is a valid recurrence date, independent of whether cron has materialized it.
- "Current" means the selected civil occurrence date, never the server's current clock day.
- A paid selected occurrence cannot be excluded by an inclusive scope; the user must reverse that payment separately. Paid later occurrences remain as history.

Open questions: none for this additive endpoint.

## User Stories

As a household editor, I want to exclude a selected fixed expense date, that date and later dates, or only later dates, while keeping paid history and accurate account and invoice records.

### Acceptance Criteria

- REC-01: WHEN an editor excludes `CURRENT_ONLY` for a valid civil occurrence date THEN the system SHALL remove the selected unpaid occurrence from reads, retain future dates, and return an idempotent replay on repetition.
- REC-02: WHEN an editor excludes `CURRENT_AND_FUTURE` THEN the system SHALL remove the selected unpaid occurrence and later unpaid occurrences; WHEN scope is `FUTURE_ONLY` THEN the system SHALL retain the selected occurrence and remove only later unpaid occurrences.
- REC-03: WHEN an exclusion reaches paid transactions THEN the system SHALL retain paid history unchanged; IF the selected date is paid and scope is inclusive THEN the system SHALL return a stable conflict.
- REC-04: WHEN an exclusion reaches materialized unpaid transactions THEN the system SHALL soft delete them atomically with the exclusion and update any open invoice total.
- REC-05: WHEN a scheduler or payment attempts an excluded occurrence THEN the system SHALL prevent materialization and payment while advancing the schedule; IF a request lacks editor access or has an invalid civil date THEN the system SHALL reject it.

Existing `DELETE /v1/recurring-transactions/:recurringId` remains compatible. The new endpoint is additive.

## Requirement Traceability

| Requirement ID | Evidence | Status |
| --- | --- | --- |
| REC-01 | `tests/integration/recurring-exclusion.test.ts` single-date/idempotency | Implemented |
| REC-02 | Same suite cutoff tests | Implemented |
| REC-03 | Same suite paid-history test | Implemented |
| REC-04 | Same suite bank/card pending and rollback tests | Implemented |
| REC-05 | Same suite scheduler/payment/invalid-date tests; route editor guard | Implemented |
