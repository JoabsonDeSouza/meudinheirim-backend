import { describe, expect, it } from 'vitest';

import { createTransactionPlanV1Schema } from '../../src/modules/transactions/transaction-plans.v1.schema.js';
import { calculateMonthlyInstallmentDates, instantAtCivilDateLike, splitTotalIntoInstallments } from '../../src/modules/transactions/transaction-plan.js';

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
  it('accepts an expense total with 2–24 installments', () => {
    expect(createTransactionPlanV1Schema.safeParse(validPlan).success).toBe(true);
    expect(createTransactionPlanV1Schema.safeParse({ ...validPlan, plan: { type: 'INSTALLMENTS', count: 2 } }).success).toBe(true);
    expect(createTransactionPlanV1Schema.safeParse({ ...validPlan, plan: { type: 'INSTALLMENTS', count: 24 } }).success).toBe(true);
    expect(createTransactionPlanV1Schema.safeParse({ ...validPlan, occurredAt: '2026-01-31T12:00:00+00:00' }).success).toBe(true);
  });

  it('accepts monthly recurrence and rejects invalid or conflicting options', () => {
    expect(createTransactionPlanV1Schema.safeParse({ ...validPlan, plan: { type: 'RECURRING_MONTHLY' } }).success).toBe(true);
    expect(createTransactionPlanV1Schema.safeParse({ ...validPlan, kind: 'income', categoryCode: 'SALARY', plan: { type: 'RECURRING_MONTHLY' } }).success).toBe(true);
    expect(createTransactionPlanV1Schema.safeParse({ ...validPlan, kind: 'income', categoryCode: 'SALARY' }).success).toBe(false);
    expect(createTransactionPlanV1Schema.safeParse({ ...validPlan, plan: { type: 'INSTALLMENTS', count: 1 } }).success).toBe(false);
    expect(createTransactionPlanV1Schema.safeParse({ ...validPlan, plan: { type: 'INSTALLMENTS', count: 25 } }).success).toBe(false);
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
    const maxCountAmounts = splitTotalIntoInstallments(2401, 24);
    expect(maxCountAmounts).toHaveLength(24);
    expect(maxCountAmounts).toEqual([101, ...Array<number>(23).fill(100)]);
    expect(maxCountAmounts.reduce((sum, amount) => sum + amount, 0)).toBe(2401);
  });

  it('generates exactly 24 monthly installments with the original anchor', () => {
    const dates = calculateMonthlyInstallmentDates(new Date('2026-01-31T00:00:00.000Z'), 24);
    expect(dates).toHaveLength(24);
    expect(dates[0].toISOString().slice(0, 10)).toBe('2026-01-31');
    expect(dates[1].toISOString().slice(0, 10)).toBe('2026-02-28');
    expect(dates[2].toISOString().slice(0, 10)).toBe('2026-03-31');
    expect(dates[23].toISOString().slice(0, 10)).toBe('2027-12-31');
    expect(() => calculateMonthlyInstallmentDates(new Date('2026-01-31T00:00:00.000Z'), 25)).toThrow(RangeError);
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

  it('retains the local civil date and wall-clock time across UTC offsets', () => {
    const nextOccurrence = instantAtCivilDateLike(
      new Date('2026-02-28T00:00:00.000Z'),
      new Date('2026-01-30T15:00:00.000Z'),
      'Asia/Tokyo',
    );
    expect(nextOccurrence.toISOString()).toBe('2026-02-27T15:00:00.000Z');
    const localParts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(nextOccurrence).map((part) => [part.type, part.value]));
    expect(localParts).toMatchObject({ year: '2026', month: '02', day: '28', hour: '00', minute: '00' });
  });
});
