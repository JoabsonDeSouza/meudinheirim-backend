import { describe, expect, it } from 'vitest';

import { createRecurringV1Schema, updateRecurringV1Schema } from '../../src/modules/recurring-transactions/recurring.v1.schema.js';

const base = {
  accountId: '6a25212c-cdd7-49e9-bff6-4b924cd146d2',
  categoryCode: 'FOOD',
  amount: { minorUnits: 3500, currency: 'BRL' },
  frequency: 'MONTHLY',
  startDate: '2026-01-31',
  timeZone: 'America/Sao_Paulo',
};

describe('recurring V1 contract', () => {
  it('defaults to a fixed unlimited schedule for existing clients', () => {
    expect(createRecurringV1Schema.parse(base)).toMatchObject({ kind: 'FIXED' });
  });

  it('requires an explicit bound for limited recurrence and counts the initial date', () => {
    expect(createRecurringV1Schema.safeParse({ ...base, recurrenceMode: 'LIMITED' }).success).toBe(false);
    expect(createRecurringV1Schema.safeParse({ ...base, recurrenceMode: 'LIMITED', occurrencesLimit: 3 }).success).toBe(true);
    expect(createRecurringV1Schema.safeParse({ ...base, recurrenceMode: 'ONCE', occurrencesLimit: 2 }).success).toBe(false);
  });

  it('allows variable estimates and strict partial schedule edits', () => {
    expect(createRecurringV1Schema.safeParse({ ...base, kind: 'VARIABLE', recurrenceMode: 'ALWAYS' }).success).toBe(true);
    expect(updateRecurringV1Schema.safeParse({ kind: 'VARIABLE' }).success).toBe(true);
    expect(updateRecurringV1Schema.safeParse({ isActive: false }).success).toBe(false);
  });
});
