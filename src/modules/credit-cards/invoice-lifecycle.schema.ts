import { z } from 'zod';
import { moneyDtoSchema } from '../../shared/money/index.js';

const timeZoneSchema = z.string().min(1).max(64).refine((value) => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}, 'timeZone must be a valid IANA time zone');

export const invoiceIdParamsSchema = z.object({ invoiceId: z.string().uuid() }).strict();

export const closeInvoiceSchema = z.object({
  clientMutationId: z.string().uuid(),
  expectedVersion: z.number().int().positive(),
}).strict();

export type CloseInvoiceInput = z.infer<typeof closeInvoiceSchema>;

export const payInvoiceV1Schema = z.object({
  clientMutationId: z.string().uuid(),
  expectedVersion: z.number().int().positive(),
  sourceAccountId: z.string().uuid(),
  expectedSourceVersion: z.number().int().positive(),
  expectedCardVersion: z.number().int().positive(),
  amount: moneyDtoSchema.refine((value) => value.minorUnits > 0, 'Payment amount must be positive').optional(),
  timeZone: timeZoneSchema,
}).strict();

export type PayInvoiceV1Input = z.infer<typeof payInvoiceV1Schema>;

export const refundInvoiceV1Schema = z.object({
  clientMutationId: z.string().uuid(),
  expectedVersion: z.number().int().positive(),
  paymentId: z.string().uuid(),
  expectedSourceVersion: z.number().int().positive(),
  expectedCardVersion: z.number().int().positive(),
  timeZone: timeZoneSchema,
}).strict();

export type RefundInvoiceV1Input = z.infer<typeof refundInvoiceV1Schema>;

export const invoiceCloseResultSchema = z.object({
  invoiceId: z.string().uuid(),
  status: z.enum(['CLOSED']),
  version: z.number().int().positive(),
  closedAt: z.string().datetime(),
}).strict();

export const invoicePaymentResultSchema = z.object({
  invoiceId: z.string().uuid(),
  status: z.enum(['CLOSED', 'PAID']),
  version: z.number().int().positive(),
  paymentId: z.string().uuid(),
  transactionId: z.string().uuid(),
  paidAmount: moneyDtoSchema,
  outstandingAmount: moneyDtoSchema,
}).strict();

export const invoiceRefundResultSchema = z.object({
  invoiceId: z.string().uuid(),
  status: z.enum(['CLOSED', 'PAID']),
  version: z.number().int().positive(),
  refundTransactionId: z.string().uuid(),
}).strict();

export type InvoiceCloseResult = z.infer<typeof invoiceCloseResultSchema>;
export type InvoicePaymentResult = z.infer<typeof invoicePaymentResultSchema>;
export type InvoiceRefundResult = z.infer<typeof invoiceRefundResultSchema>;
