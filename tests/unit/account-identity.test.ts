import { describe, expect, it } from 'vitest';

import { createAccountSchema, updateAccountSchema } from '../../src/modules/accounts/accounts.schema.js';

describe('account identity fields', () => {
  it('accepts supported currencies and optional presentation identity fields', () => {
    const result = createAccountSchema.safeParse({
      name: 'Nubank Platinum',
      type: 'CREDIT',
      currency: 'BRL',
      institution: 'Nubank',
      brand: 'Ultravioleta',
      cardNetwork: 'MASTERCARD',
      last4: '0427',
    });
    expect(result.success).toBe(true);
  });

  it('rejects unsupported currency values', () => {
    expect(createAccountSchema.safeParse({ name: 'Account', type: 'CASH', currency: 'EUR' }).success).toBe(false);
  });

  it('rejects malformed last4 and bounds display strings', () => {
    expect(createAccountSchema.safeParse({ name: 'Card', type: 'CREDIT', last4: '427' }).success).toBe(false);
    expect(createAccountSchema.safeParse({ name: 'Card', type: 'CREDIT', last4: '04A7' }).success).toBe(false);
    expect(createAccountSchema.safeParse({ name: 'Card', type: 'CREDIT', brand: 'x'.repeat(51) }).success).toBe(false);
  });

  it('allows clearing optional identity fields during update', () => {
    const result = updateAccountSchema.safeParse({
      currency: 'USD',
      institution: null,
      brand: null,
      cardNetwork: null,
      last4: null,
    });
    expect(result.success).toBe(true);
  });
});
