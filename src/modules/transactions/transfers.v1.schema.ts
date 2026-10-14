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
