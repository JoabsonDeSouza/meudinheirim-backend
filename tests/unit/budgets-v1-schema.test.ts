import { describe, expect, it } from 'vitest';

import { createBudgetV1Schema } from '../../src/modules/budgets/budgets.v1.schema.js';

describe('V1 budget MoneyDto contract', () => {
  it('requires a MoneyDto currency and stable category code', () => {
    const base = {
      categoryCode: 'FOOD',
      type: 'EXPENSE',
      month: '2026-10',
      monthlyLimit: { minorUnits: 25000, currency: 'BRL' },
    };
    expect(createBudgetV1Schema.safeParse(base).success).toBe(true);
    expect(createBudgetV1Schema.safeParse({ ...base, monthlyLimit: { minorUnits: 25000 } }).success).toBe(false);
    expect(createBudgetV1Schema.safeParse({ ...base, monthlyLimit: { minorUnits: 25000, currency: 'EUR' } }).success).toBe(false);
    expect(createBudgetV1Schema.safeParse({ ...base, monthlyLimit: { minorUnits: 250.5, currency: 'BRL' } }).success).toBe(false);
  });
});
