import { describe, expect, it } from 'vitest';

import { updateUserPreferencesSchema } from '../../src/modules/users/users.schema.js';
import { createAccountSchema } from '../../src/modules/accounts/accounts.schema.js';
import { createTransactionSchema } from '../../src/modules/transactions/transactions.schema.js';

describe('updateUserPreferencesSchema (mass assignment protection)', () => {
  it('rejects server-owned field isPremium', () => {
    const result = updateUserPreferencesSchema.safeParse({ isPremium: true });
    expect(result.success).toBe(false);
  });

  it('rejects unknown fields', () => {
    const result = updateUserPreferencesSchema.safeParse({ evilFlag: true });
    expect(result.success).toBe(false);
  });

  it('rejects unknown account and transaction input fields', () => {
    const account = createAccountSchema.safeParse({
      name: 'Account',
      type: 'CHECKING',
      isPremium: true,
    });
    expect(account.success).toBe(false);

    const transaction = createTransactionSchema.safeParse({
      accountId: '8d2f412d-1b0c-4e97-b4d7-53b5c45a7d4f',
      categoryName: 'FOOD',
      amount: 100,
      date: '2026-01-01',
      householdId: '8d2f412d-1b0c-4e97-b4d7-53b5c45a7d4f',
      ownerId: '8d2f412d-1b0c-4e97-b4d7-53b5c45a7d4f',
    });
    expect(transaction.success).toBe(false);
  });

  it('rejects attachmentUrl as an inactive upload/metadata surface', () => {
    const result = createTransactionSchema.safeParse({
      householdId: '8d2f412d-1b0c-4e97-b4d7-53b5c45a7d4f',
      type: 'EXPENSE',
      accountId: '8d2f412d-1b0c-4e97-b4d7-53b5c45a7d4f',
      categoryName: 'FOOD',
      amount: 100,
      date: '2026-10-14',
      attachmentUrl: 'invoice_pay:5a7cde52-ae08-4ce0-92a4-c6a87127e130:2026-9',
    });
    expect(result.success).toBe(false);
  });

  it('rejects server-owned recurrence job state', () => {
    expect(
      updateUserPreferencesSchema.safeParse({ lastRecurringProcessedMonth: '2026-01' }).success,
    ).toBe(false);
    expect(
      updateUserPreferencesSchema.safeParse({ lastRecurringProcessedAt: new Date() }).success,
    ).toBe(false);
  });

  it('constrains baseCurrency to supported currencies', () => {
    expect(updateUserPreferencesSchema.safeParse({ baseCurrency: 'BRL' }).success).toBe(true);
    expect(updateUserPreferencesSchema.safeParse({ baseCurrency: 'USD' }).success).toBe(true);
    expect(updateUserPreferencesSchema.safeParse({ baseCurrency: 'EUR' }).success).toBe(false);
  });

  it('constrains locale to supported catalogues', () => {
    expect(updateUserPreferencesSchema.safeParse({ locale: 'pt-BR' }).success).toBe(true);
    expect(updateUserPreferencesSchema.safeParse({ locale: 'en-US' }).success).toBe(true);
    expect(updateUserPreferencesSchema.safeParse({ locale: 'pt-BR-x-fake' }).success).toBe(false);
  });
});
