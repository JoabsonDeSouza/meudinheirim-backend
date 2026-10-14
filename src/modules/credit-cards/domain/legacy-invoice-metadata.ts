export interface LegacyInvoicePaymentMetadata {
  readonly cardAccountId: string;
  readonly year: number;
  /** Legacy `M` field is zero-based (0=January, 11=December). */
  readonly monthIndex: number;
}

const LEGACY_PAYMENT_PATTERN = /^invoice_pay:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):(\d{4})-(0|[1-9]|1[01])$/i;

export function parseLegacyInvoicePaymentMetadata(value: string | null): LegacyInvoicePaymentMetadata | null {
  if (value === null) return null;
  const match = LEGACY_PAYMENT_PATTERN.exec(value);
  if (!match) return null;
  const year = Number(match[2]);
  if (!Number.isInteger(year) || year < 1900 || year > 9999) return null;
  return {
    cardAccountId: match[1],
    year,
    monthIndex: Number(match[3]),
  };
}
