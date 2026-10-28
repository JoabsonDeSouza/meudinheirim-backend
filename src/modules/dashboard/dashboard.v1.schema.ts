import { z } from 'zod';
import { moneyDtoSchema } from '../../shared/money/index.js';

const householdQuerySchema = z.object({ householdId: z.string().uuid().optional() }).strict();

export const dashboardOverviewV1QuerySchema = householdQuerySchema.extend({
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Month must be a valid YYYY-MM month'),
}).strict();

export const dashboardRecentV1QuerySchema = householdQuerySchema;

export const dashboardCurrencySummaryV1Schema = z.object({
  currency: z.enum(['BRL', 'USD']),
  income: moneyDtoSchema,
  expense: moneyDtoSchema,
  balance: moneyDtoSchema,
}).strict();

export const dashboardOverviewV1ResponseSchema = z.object({
  month: z.string(),
  byCurrency: z.array(dashboardCurrencySummaryV1Schema),
}).strict();

export const dashboardRecentTransactionV1Schema = z.object({
  id: z.string().uuid(),
  kind: z.enum(['income', 'expense', 'transfer']),
  amount: moneyDtoSchema,
  categoryCode: z.string().nullable(),
  accountId: z.string().uuid().nullable(),
  fromAccountId: z.string().uuid().nullable(),
  toAccountId: z.string().uuid().nullable(),
  invoiceId: z.string().uuid().nullable(),
  installmentId: z.string().uuid().nullable(),
  installmentNumber: z.number().int().min(1).max(24).nullable(),
  totalInstallments: z.number().int().min(2).max(24).nullable(),
  installmentTotalAmount: moneyDtoSchema.nullable(),
  occurredAt: z.string().datetime(),
  timeZone: z.string(),
  note: z.string().nullable(),
  paid: z.boolean(),
  version: z.number().int().positive(),
  clientMutationId: z.string().uuid(),
}).strict();

export const dashboardRecentV1ResponseSchema = z.object({
  items: z.array(dashboardRecentTransactionV1Schema).max(10),
}).strict();

export type DashboardOverviewV1Query = z.infer<typeof dashboardOverviewV1QuerySchema>;
export type DashboardRecentV1Query = z.infer<typeof dashboardRecentV1QuerySchema>;
export type DashboardOverviewV1Response = z.infer<typeof dashboardOverviewV1ResponseSchema>;
export type DashboardRecentV1Response = z.infer<typeof dashboardRecentV1ResponseSchema>;
