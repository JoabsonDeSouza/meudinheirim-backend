import { z } from 'zod';
import { moneyDtoSchema } from '../../shared/money/index.js';
import { paginationSchema } from '../../shared/utils/pagination.js';
import { categoryNameSchema } from '../categories/categories.schema.js';

const timeZoneSchema = z.string().min(1).max(64).refine((value) => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}, 'timeZone must be a valid IANA time zone');

export const transactionKindV1Schema = z.enum(['expense', 'income']);

export const transactionAmountV1Schema = moneyDtoSchema.refine(
  (money) => money.minorUnits > 0,
  'Transaction amount must be positive',
);

export const createTransactionV1Schema = z.object({
  householdId: z.string().uuid().optional(),
  clientMutationId: z.string().uuid(),
  kind: transactionKindV1Schema,
  amount: transactionAmountV1Schema,
  categoryCode: categoryNameSchema,
  accountId: z.string().uuid(),
  occurredAt: z.string().datetime(),
  timeZone: timeZoneSchema,
  note: z.string().max(1000).optional(),
  paid: z.boolean().default(true),
}).strict();

export type CreateTransactionV1Input = z.infer<typeof createTransactionV1Schema>;

export const updateTransactionV1Schema = z.object({
  clientMutationId: z.string().uuid(),
  expectedVersion: z.number().int().positive(),
  amount: transactionAmountV1Schema.optional(),
  categoryCode: categoryNameSchema.optional(),
  occurredAt: z.string().datetime().optional(),
  timeZone: timeZoneSchema.optional(),
  note: z.string().max(1000).nullable().optional(),
  paid: z.boolean().optional(),
}).strict().refine((value) => Object.keys(value).some((key) => !['clientMutationId', 'expectedVersion'].includes(key)), {
  message: 'At least one transaction field must be provided',
});

export type UpdateTransactionV1Input = z.infer<typeof updateTransactionV1Schema>;

export const listTransactionsV1QuerySchema = paginationSchema.extend({
  householdId: z.string().uuid().optional(),
  accountId: z.string().uuid().optional(),
  kind: transactionKindV1Schema.optional(),
  categoryCode: categoryNameSchema.optional(),
  occurredAfter: z.string().datetime().optional(),
  occurredBefore: z.string().datetime().optional(),
}).strict();

export type ListTransactionsV1Query = z.infer<typeof listTransactionsV1QuerySchema>;

export const transactionV1ParamsSchema = z.object({
  transactionId: z.string().uuid(),
}).strict();

export const transactionV1HouseholdQuerySchema = z.object({
  householdId: z.string().uuid().optional(),
  clientMutationId: z.string().uuid().optional(),
  expectedVersion: z.coerce.number().int().positive().optional(),
}).strict();

export const transactionV1DtoSchema = z.object({
  id: z.string().uuid(),
  kind: transactionKindV1Schema,
  amount: moneyDtoSchema,
  categoryCode: categoryNameSchema,
  accountId: z.string().uuid(),
  invoiceId: z.string().uuid().nullable(),
  occurredAt: z.string().datetime(),
  timeZone: timeZoneSchema,
  note: z.string().nullable(),
  paid: z.boolean(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  deletedAt: z.string().datetime().nullable(),
  version: z.number().int().positive(),
  clientMutationId: z.string().uuid(),
}).strict();

export type TransactionV1Dto = z.infer<typeof transactionV1DtoSchema>;
