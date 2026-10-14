import { z } from 'zod';
import { moneyDtoSchema } from '../../shared/money/index.js';

const transferAmountSchema = moneyDtoSchema.refine(
  (value) => value.minorUnits > 0,
  'Transfer amount must be positive',
);

const ianaTimeZoneSchema = z.string().min(1).max(64).refine((value) => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}, 'timeZone must be a valid IANA time zone');

export const createTransferV1Schema = z.object({
  householdId: z.string().uuid().optional(),
  clientMutationId: z.string().uuid(),
  fromAccountId: z.string().uuid(),
  toAccountId: z.string().uuid(),
  amount: transferAmountSchema,
  expectedFromVersion: z.number().int().positive(),
  expectedToVersion: z.number().int().positive(),
  occurredAt: z.string().datetime(),
  timeZone: ianaTimeZoneSchema,
  note: z.string().max(1000).optional(),
}).strict().refine((value) => value.fromAccountId !== value.toAccountId, {
  message: 'Transfer source and destination accounts must differ',
  path: ['toAccountId'],
});

export type CreateTransferV1Input = z.infer<typeof createTransferV1Schema>;

export const transferV1DtoSchema = z.object({
  transaction: z.object({
    id: z.string().uuid(),
    kind: z.literal('transfer'),
    amount: moneyDtoSchema,
    fromAccountId: z.string().uuid(),
    toAccountId: z.string().uuid(),
    occurredAt: z.string().datetime(),
    timeZone: z.string(),
    note: z.string().nullable(),
    version: z.number().int().positive(),
    clientMutationId: z.string().uuid(),
  }).strict(),
  fromVersion: z.number().int().positive(),
  toVersion: z.number().int().positive(),
}).strict();

export type TransferV1Dto = z.infer<typeof transferV1DtoSchema>;
