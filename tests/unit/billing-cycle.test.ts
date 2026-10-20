import { describe, expect, it } from 'vitest';

import { calculateBillingCycle } from '../../src/modules/credit-cards/domain/billing-cycle.js';

describe('billing cycle boundaries', () => {
  it('uses the prior closing date as inclusive start and current close as exclusive end', () => {
    const cycle = calculateBillingCycle('2026-10-07T23:00:00.000Z', 8, 15, 'America/Sao_Paulo');
    expect(cycle).toEqual({
      periodStart: '2026-09-08',
      periodEnd: '2026-10-08',
      dueDate: '2026-10-15',
    });
  });

  it('assigns a purchase on closing day to the next cycle', () => {
    const cycle = calculateBillingCycle('2026-10-08T15:00:00.000Z', 8, 15, 'America/Sao_Paulo');
    expect(cycle.periodStart).toBe('2026-10-08');
    expect(cycle.periodEnd).toBe('2026-11-08');
    expect(cycle.dueDate).toBe('2026-11-15');
  });

  it('uses the cardholder local date at DST boundaries', () => {
    const cycle = calculateBillingCycle('2024-03-10T04:30:00.000Z', 9, 20, 'America/New_York');
    expect(cycle.periodStart).toBe('2024-03-09');
    expect(cycle.periodEnd).toBe('2024-04-09');
  });

  it('clamps month-end cycle days and uses calendar-month cycles when closingDay is absent', () => {
    const closingAtMonthEnd = calculateBillingCycle('2025-01-30T12:00:00.000Z', 31, 5, 'UTC');
    expect(closingAtMonthEnd.periodEnd).toBe('2025-01-31');
    expect(closingAtMonthEnd.dueDate).toBe('2025-02-05');

    const calendarMonth = calculateBillingCycle('2025-10-15T12:00:00.000Z', null, 5, 'UTC');
    expect(calendarMonth.periodStart).toBe('2025-10-01');
    expect(calendarMonth.periodEnd).toBe('2025-11-01');
    expect(calendarMonth.dueDate).toBe('2025-11-05');
  });

  it('rejects invalid IANA time zones', () => {
    expect(() => calculateBillingCycle('2026-10-07T23:00:00.000Z', 8, 15, 'Mars/Olympus')).toThrow(/time zone/i);
  });
});
