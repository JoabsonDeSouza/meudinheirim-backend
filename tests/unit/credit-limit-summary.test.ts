import { describe, expect, it } from 'vitest';
import { Prisma } from '../../src/generated/prisma/client.js';

import { buildCreditLimitSummary } from '../../src/modules/accounts/credit-limit-summary.js';

describe('credit limit summary', () => {
  it('returns ready-to-render total, used, available and utilization values', () => {
    expect(buildCreditLimitSummary({
      type: 'CREDIT',
      currency: 'BRL',
      creditLimit: new Prisma.Decimal('5000.00'),
      totalLimit: new Prisma.Decimal('5000.00'),
      availableLimit: new Prisma.Decimal('5000.00'),
    }, new Prisma.Decimal('30.00'))).toEqual({
      total: { minorUnits: 500000, currency: 'BRL' },
      used: { minorUnits: 3000, currency: 'BRL' },
      available: { minorUnits: 497000, currency: 'BRL' },
      utilizationPercent: 0.6,
    });
  });

  it('does not expose credit-limit data for bank accounts', () => {
    expect(buildCreditLimitSummary({
      type: 'CHECKING',
      currency: 'BRL',
      creditLimit: null,
      totalLimit: null,
      availableLimit: null,
    })).toBeNull();
  });
});
