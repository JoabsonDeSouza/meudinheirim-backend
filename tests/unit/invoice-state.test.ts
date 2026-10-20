import { describe, expect, it } from 'vitest';

import { transitionInvoiceStatus } from '../../src/modules/credit-cards/domain/invoice-state.js';

describe('invoice lifecycle state machine', () => {
  it('transitions OPEN -> CLOSED -> PAID -> CLOSED on refund', () => {
    expect(transitionInvoiceStatus('OPEN', 'close')).toBe('CLOSED');
    expect(transitionInvoiceStatus('CLOSED', 'pay')).toBe('PAID');
    expect(transitionInvoiceStatus('PAID', 'refund')).toBe('CLOSED');
  });

  it('rejects payment before close and repeated closing with a stable conflict', () => {
    expect(() => transitionInvoiceStatus('OPEN', 'pay')).toThrowError(/cannot pay invoice in open state/i);
    try {
      transitionInvoiceStatus('CLOSED', 'close');
    } catch (error) {
      expect(error).toMatchObject({ code: 'INVALID_INVOICE_TRANSITION', statusCode: 409 });
    }
  });
});
