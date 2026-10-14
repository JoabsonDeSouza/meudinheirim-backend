import { describe, expect, it } from 'vitest';

import { createTransferV1Schema } from '../../src/modules/transactions/transfers.v1.schema.js';

const transfer = {
  clientMutationId: '0d384bb4-d7d0-427e-93a1-4011d2ad2767',
  householdId: 'f531b2aa-0083-4f63-b0d1-5f9f1c3bce43',
  fromAccountId: '5a7cde52-ae08-4ce0-92a4-c6a87127e130',
  toAccountId: 'e5acba7c-5150-4f4a-9dce-a79fb2f31c11',
  amount: { minorUnits: 2500, currency: 'BRL' },
  expectedFromVersion: 1,
  expectedToVersion: 1,
  occurredAt: '2026-10-13T12:34:56.000Z',
  timeZone: 'America/Sao_Paulo',
};

describe('V1 transfer contract', () => {
  it('accepts a transfer with integer MoneyDto and expected account versions', () => {
    expect(createTransferV1Schema.safeParse(transfer).success).toBe(true);
  });

  it('rejects same-account transfer, non-positive amount, missing currency and fractional minor units', () => {
    expect(createTransferV1Schema.safeParse({ ...transfer, toAccountId: transfer.fromAccountId }).success).toBe(false);
    expect(createTransferV1Schema.safeParse({ ...transfer, amount: { minorUnits: 0, currency: 'BRL' } }).success).toBe(false);
    expect(createTransferV1Schema.safeParse({ ...transfer, amount: { minorUnits: 100 } }).success).toBe(false);
    expect(createTransferV1Schema.safeParse({ ...transfer, amount: { minorUnits: 1.5, currency: 'BRL' } }).success).toBe(false);
  });
});
