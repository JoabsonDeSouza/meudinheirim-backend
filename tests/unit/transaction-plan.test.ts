import { describe, expect, it } from 'vitest';

import { createTransactionPlanV1Schema } from '../../src/modules/transactions/transaction-plans.v1.schema.js';
import { calculateMonthlyInstallmentDates, splitTotalIntoInstallments } from '../../src/modules/transactions/transaction-plan.js';

const validPlan = {
  clientMutationId: 'a0123456-789b-4cde-8f01-23456789abcd',
  kind: 'expense',
  totalAmount: { minorUnits: 10001, currency: 'BRL' },
  categoryCode: 'FOOD',
  accountId: '5a7cde52-ae08-4ce0-92a4-c6a87127e130',
  occurredAt: '2026-01-31T12:00:00.000Z',
  timeZone: 'America/Sao_Paulo',
  plan: { type: 'INSTALLMENTS', count: 4 },
};

describe('transaction plan contract', () => {
  it('accepts an expense total with 2–6 installments', () => {
    expect(createTransactionPlanV1Schema.safeParse(validPlan).success).toBe(true);
    expect(createTransactionPlanV1Schema.safeParse({ ...validPlan, plan: { type: 'INSTALLMENTS', count: 2 } }).success).toBe(true);
    expect(createTransactionPlanV1Schema.safeParse({ ...validPlan, plan: { type: 'INSTALLMENTS', count: 6 } }).success).toBe(true);
  });

  it('accepts monthly recurrence and rejects invalid or conflicting options', () => {
    expect(createTransactionPlanV1Schema.safeParse({ ...validPlan, plan: { type: 'RECURRING_MONTHLY' } }).success).toBe(true);
    expect(createTransactionPlanV1Schema.safeParse({ ...validPlan, plan: { type: 'INSTALLMENTS', count: 1 } }).success).toBe(false);
    expect(createTransactionPlanV1Schema.safeParse({ ...validPlan, plan: { type: 'INSTALLMENTS', count: 7 } }).success).toBe(false);
    expect(createTransactionPlanV1Schema.safeParse({ ...validPlan, totalAmount: { minorUnits: 3, currency: 'BRL' } }).success).toBe(false);
    expect(createTransactionPlanV1Schema.safeParse({ ...validPlan, kind: 'income' }).success).toBe(false);
    expect(createTransactionPlanV1Schema.safeParse({ ...validPlan, plan: { type: 'INSTALLMENTS', count: 3, frequency: 'MONTHLY' } }).success).toBe(false);
    expect(createTransactionPlanV1Schema.safeParse({ ...validPlan, unsupported: true }).success).toBe(false);
  });
});

describe('transaction installment math', () => {
  it('distributes remainder cents to earliest installments and preserves the total', () => {
    const amounts = splitTotalIntoInstallments(10001, 4);
    expect(amounts).toEqual([2501, 2500, 2500, 2500]);
    expect(amounts.reduce((sum, item) => sum + item, 0)).toBe(10001);
    expect(splitTotalIntoInstallments(101, 3)).toEqual([34, 34, 33]);
    expect(() => splitTotalIntoInstallments(3, 4)).toThrow(RangeError);
  });

  it('retains the original monthly day anchor after clamping short months', () => {
    const dates = calculateMonthlyInstallmentDates(new Date('2026-01-31T00:00:00.000Z'), 4);
    expect(dates.map((date) => date.toISOString().slice(0, 10))).toEqual([
      '2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30',
    ]);
    expect(calculateMonthlyInstallmentDates(new Date('2028-01-31T00:00:00.000Z'), 3).map((date) => date.toISOString().slice(0, 10))).toEqual([
      '2028-01-31', '2028-02-29', '2028-03-31',
    ]);
  });
});
