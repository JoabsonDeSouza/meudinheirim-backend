import { describe, expect, it } from 'vitest';

import { createTransactionV1Schema } from '../../src/modules/transactions/transactions.v1.schema.js';

const validInput = {
  clientMutationId: '7c294a5b-c0e1-49cf-aeb3-ff1e71235664',
  kind: 'expense',
  amount: { minorUnits: 1234, currency: 'BRL' },
  categoryCode: 'FOOD',
  accountId: '5a7cde52-ae08-4ce0-92a4-c6a87127e130',
  occurredAt: '2026-10-13T12:34:56.000Z',
  timeZone: 'America/Sao_Paulo',
  note: 'market',
};

describe('V1 transaction DTO validation', () => {
  it('accepts money with a stable category code, UUID account and UTC instant', () => {
    expect(createTransactionV1Schema.safeParse(validInput).success).toBe(true);
  });

  it('rejects decimal amounts, missing currency, invalid UUID and unknown fields', () => {
    expect(createTransactionV1Schema.safeParse({ ...validInput, amount: { minorUnits: 1.25, currency: 'BRL' } }).success).toBe(false);
    expect(createTransactionV1Schema.safeParse({ ...validInput, amount: { minorUnits: 100 } }).success).toBe(false);
    expect(createTransactionV1Schema.safeParse({ ...validInput, accountId: 'bank-name' }).success).toBe(false);
    expect(createTransactionV1Schema.safeParse({ ...validInput, isPremium: true }).success).toBe(false);
  });

  it('bounds notes and requires an explicit UTC timestamp', () => {
    expect(createTransactionV1Schema.safeParse({ ...validInput, note: 'x'.repeat(1001) }).success).toBe(false);
    expect(createTransactionV1Schema.safeParse({ ...validInput, occurredAt: '2026-10-13T12:34:56' }).success).toBe(false);
    expect(createTransactionV1Schema.safeParse({ ...validInput, timeZone: 'Mars/Olympus' }).success).toBe(false);
  });
});
