import { describe, expect, it } from 'vitest';

import { createTransactionV1Schema } from '../../src/modules/transactions/transactions.v1.schema.js';
import { decodeSyncCursor, encodeSyncCursor } from '../../src/shared/sync/cursor.js';

describe('V1 sync contracts', () => {
  it('requires clientMutationId for writes', () => {
    const result = createTransactionV1Schema.safeParse({
      kind: 'expense',
      amount: { minorUnits: 100, currency: 'BRL' },
      categoryCode: 'FOOD',
      accountId: '5a7cde52-ae08-4ce0-92a4-c6a87127e130',
      occurredAt: '2026-10-13T12:34:56.000Z',
      timeZone: 'America/Sao_Paulo',
    });
    expect(result.success).toBe(false);
  });

  it('round-trips a monotonic sequence cursor opaquely and rejects tampering', () => {
    const cursor = encodeSyncCursor(184467n);
    expect(cursor).not.toBe('184467');
    expect(decodeSyncCursor(cursor)).toBe(184467n);
    expect(() => decodeSyncCursor('tampered')).toThrow(/cursor/i);
  });
});
