import { describe, expect, it } from 'vitest';
import { Prisma } from '../../src/generated/prisma/client.js';
import {
  decimalToMinorUnits,
  moneyDtoSchema,
  moneyFromMinorUnits,
  minorUnitsToDecimal,
  sumMoneyByCurrency,
} from '../../src/shared/money/index.js';

describe('Money DTO validation', () => {
  it('requires an integer safe minorUnits and supported currency', () => {
    expect(moneyDtoSchema.safeParse({ minorUnits: 123, currency: 'BRL' }).success).toBe(true);
    expect(moneyDtoSchema.safeParse({ minorUnits: 1.2, currency: 'BRL' }).success).toBe(false);
    expect(moneyDtoSchema.safeParse({ minorUnits: Number.MAX_SAFE_INTEGER + 1, currency: 'BRL' }).success).toBe(false);
    expect(moneyDtoSchema.safeParse({ minorUnits: 123 }).success).toBe(false);
    expect(moneyDtoSchema.safeParse({ minorUnits: 123, currency: 'EUR' }).success).toBe(false);
  });
});

describe('exact Decimal/minor-units conversion', () => {
  it('converts BRL and USD Decimal values without a float intermediary', () => {
    expect(decimalToMinorUnits(new Prisma.Decimal('12.34'), 'BRL')).toBe(1234);
    expect(decimalToMinorUnits(new Prisma.Decimal('-0.01'), 'USD')).toBe(-1);
  });

  it('rejects a value with fractional minor units', () => {
    expect(() => decimalToMinorUnits(new Prisma.Decimal('0.001'), 'BRL')).toThrow(/fractional/i);
  });

  it('rejects overflow outside the JavaScript safe-integer range', () => {
    expect(() => decimalToMinorUnits(new Prisma.Decimal('90071992547409.92'), 'USD')).toThrow(/safe integer/i);
  });

  it('round-trips exact minor units to Prisma Decimal and back', () => {
    const dto = moneyFromMinorUnits(-2345, 'BRL');
    const decimal = minorUnitsToDecimal(dto);
    expect(decimal.toFixed(2)).toBe('-23.45');
    expect(decimalToMinorUnits(decimal, 'BRL')).toBe(-2345);
  });
});

describe('multi-currency aggregation', () => {
  it('groups totals by currency and never combines different currencies', () => {
    const totals = sumMoneyByCurrency([
      { minorUnits: 100, currency: 'BRL' },
      { minorUnits: 250, currency: 'BRL' },
      { minorUnits: 500, currency: 'USD' },
    ]);
    expect(totals).toEqual([
      { minorUnits: 350, currency: 'BRL' },
      { minorUnits: 500, currency: 'USD' },
    ]);
  });

  it('rejects aggregate overflow instead of rounding', () => {
    expect(() => sumMoneyByCurrency([
      { minorUnits: Number.MAX_SAFE_INTEGER, currency: 'BRL' },
      { minorUnits: 1, currency: 'BRL' },
    ])).toThrow(/safe integer/i);
  });
});
