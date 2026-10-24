import { describe, expect, it } from 'vitest';

import { calculateNextRunDate, expandRecurrenceDates } from '../../src/modules/recurring-transactions/recurrence-date.js';

describe('civil recurrence date calculation', () => {
  it('advances civil days in UTC without DST hour drift', () => {
    const next = calculateNextRunDate(new Date('2018-11-03T00:00:00.000Z'), 'DAILY');
    expect(next.toISOString()).toBe('2018-11-04T00:00:00.000Z');
  });

  it('clamps month-end instead of overflowing into the following month', () => {
    const next = calculateNextRunDate(new Date('2025-01-31T00:00:00.000Z'), 'MONTHLY');
    expect(next.toISOString()).toBe('2025-02-28T00:00:00.000Z');
  });

  it('restores the original month-day anchor after a short month', () => {
    const next = calculateNextRunDate(new Date('2025-02-28T00:00:00.000Z'), 'MONTHLY', 31);
    expect(next.toISOString()).toBe('2025-03-31T00:00:00.000Z');
  });

  it('restores the leap-day anchor in the next leap year', () => {
    const next = calculateNextRunDate(new Date('2025-02-28T00:00:00.000Z'), 'YEARLY', 29);
    expect(next.toISOString()).toBe('2026-02-28T00:00:00.000Z');
    const leap = calculateNextRunDate(next, 'YEARLY', 29);
    expect(leap.toISOString()).toBe('2027-02-28T00:00:00.000Z');
    expect(calculateNextRunDate(leap, 'YEARLY', 29).toISOString()).toBe('2028-02-29T00:00:00.000Z');
  });

  it('expands a finite monthly schedule with the first date included and preserved anchor', () => {
    const dates = expandRecurrenceDates({
      startDate: new Date('2025-01-31T00:00:00.000Z'),
      from: new Date('2025-01-01T00:00:00.000Z'),
      to: new Date('2025-04-30T00:00:00.000Z'),
      frequency: 'MONTHLY',
      anchorDay: 31,
      recurrenceMode: 'LIMITED',
      occurrencesLimit: 4,
      endDate: null,
    });
    expect(dates.map((date) => date.toISOString().slice(0, 10))).toEqual([
      '2025-01-31', '2025-02-28', '2025-03-31', '2025-04-30',
    ]);
  });

  it('expands an ONCE schedule exactly once from its initial date', () => {
    const dates = expandRecurrenceDates({
      startDate: new Date('2025-01-31T00:00:00.000Z'),
      from: new Date('2025-01-01T00:00:00.000Z'),
      to: new Date('2026-01-31T00:00:00.000Z'),
      frequency: 'MONTHLY',
      anchorDay: 31,
      recurrenceMode: 'ONCE',
      occurrencesLimit: 1,
      endDate: null,
    });
    expect(dates.map((date) => date.toISOString().slice(0, 10))).toEqual(['2025-01-31']);
  });

  it('catches up one missed occurrence from the scheduled date, not from today', () => {
    const missed = new Date('2025-01-15T00:00:00.000Z');
    const next = calculateNextRunDate(missed, 'MONTHLY');
    expect(next.toISOString()).toBe('2025-02-15T00:00:00.000Z');
  });
});
