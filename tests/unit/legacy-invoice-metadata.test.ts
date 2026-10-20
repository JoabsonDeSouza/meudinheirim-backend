import { describe, expect, it } from 'vitest';

import { parseLegacyInvoicePaymentMetadata } from '../../src/modules/credit-cards/domain/legacy-invoice-metadata.js';

describe('legacy invoice payment marker conversion', () => {
  it('parses the card UUID and zero-based month encoded by the old payment marker', () => {
    expect(parseLegacyInvoicePaymentMetadata('invoice_pay:5a7cde52-ae08-4ce0-92a4-c6a87127e130:2026-9')).toEqual({
      cardAccountId: '5a7cde52-ae08-4ce0-92a4-c6a87127e130',
      year: 2026,
      monthIndex: 9,
    });
  });

  it('returns null for user URLs and malformed markers so migration can flag them', () => {
    expect(parseLegacyInvoicePaymentMetadata('https://example.com/receipt.png')).toBeNull();
    expect(parseLegacyInvoicePaymentMetadata('invoice_pay:not-a-uuid:2026-12')).toBeNull();
    expect(parseLegacyInvoicePaymentMetadata('invoice_pay:5a7cde52-ae08-4ce0-92a4-c6a87127e130:2026-12')).toBeNull();
  });
});
