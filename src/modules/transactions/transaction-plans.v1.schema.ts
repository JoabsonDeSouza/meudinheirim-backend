import { z } from 'zod';
import { moneyDtoSchema } from '../../shared/money/index.js';
import { transactionV1DtoSchema } from './transactions.v1.schema.js';
import { recurringManagedV1DtoSchema } from '../recurring-transactions/recurring.v1.schema.js';
import { categoryNameSchema } from '../categories/categories.schema.js';

const timeZoneSchema = z.string().min(1).max(64).refine((value) => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}, 'timeZone must be a valid IANA time zone');

export const transactionPlanV1InputSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('INSTALLMENTS'), count: z.number().int().min(2).max(6) }).strict(),
  z.object({ type: z.literal('RECURRING_MONTHLY') }).strict(),
]);

export const createTransactionPlanV1Schema = z.object({
  householdId: z.string().uuid().optional(),
  clientMutationId: z.string().uuid(),
  kind: z.literal('expense'),
  totalAmount: moneyDtoSchema.refine((money) => money.minorUnits > 0, 'Transaction amount must be positive'),
  categoryCode: categoryNameSchema,
  accountId: z.string().uuid(),
  occurredAt: z.string().datetime(),
  timeZone: timeZoneSchema,
  note: z.string().max(255).optional(),
  paid: z.boolean().default(true),
  plan: transactionPlanV1InputSchema,
}).strict().superRefine((input, ctx) => {
  if (input.plan.type === 'INSTALLMENTS' && input.totalAmount.minorUnits < input.plan.count) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['totalAmount', 'minorUnits'],
      message: 'Total amount must cover at least one minor unit per installment',
    });
  }
});

export type CreateTransactionPlanV1Input = z.infer<typeof createTransactionPlanV1Schema>;

const plannedTransactionDtoSchema = transactionV1DtoSchema.extend({
  installmentId: z.string().uuid(),
  installmentNumber: z.number().int().min(1).max(6),
  totalInstallments: z.number().int().min(2).max(6),
}).strict();

export const transactionPlanV1ResponseSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('INSTALLMENTS'),
    installmentId: z.string().uuid(),
    totalAmount: moneyDtoSchema,
    installmentCount: z.number().int().min(2).max(6),
    items: z.array(plannedTransactionDtoSchema).min(2).max(6),
  }).strict(),
  z.object({
    type: z.literal('RECURRING_MONTHLY'),
    recurringTransaction: recurringManagedV1DtoSchema,
    firstOccurrence: transactionV1DtoSchema,
  }).strict(),
]);

export type TransactionPlanV1Response = z.infer<typeof transactionPlanV1ResponseSchema>;
