import { describe, expect, it } from 'vitest';

import { calculateNextRunDate } from '../../src/modules/recurring-transactions/recurrence-date.js';

describe('civil recurrence date calculation', () => {
  it('advances civil days in UTC without DST hour drift', () => {
    const next = calculateNextRunDate(new Date('2018-11-03T00:00:00.000Z'), 'DAILY');
    expect(next.toISOString()).toBe('2018-11-04T00:00:00.000Z');
  });

  it('clamps month-end instead of overflowing into the following month', () => {
    const next = calculateNextRunDate(new Date('2025-01-31T00:00:00.000Z'), 'MONTHLY');
    expect(next.toISOString()).toBe('2025-02-28T00:00:00.000Z');
  });

  it('catches up one missed occurrence from the scheduled date, not from today', () => {
    const missed = new Date('2025-01-15T00:00:00.000Z');
    const next = calculateNextRunDate(missed, 'MONTHLY');
    expect(next.toISOString()).toBe('2025-02-15T00:00:00.000Z');
  });
});
