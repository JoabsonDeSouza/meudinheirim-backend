import { z } from 'zod';
import { RecurrenceFrequency } from '../../shared/enums/index.js';
import { moneyDtoSchema } from '../../shared/money/index.js';
import { categoryNameSchema } from '../categories/categories.schema.js';

const timeZoneSchema = z.string().min(1).max(64).refine((value) => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}, 'timeZone must be a valid IANA time zone');

const civilDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const createRecurringV1Schema = z.object({
  householdId: z.string().uuid().optional(),
  accountId: z.string().uuid(),
  categoryCode: categoryNameSchema,
  amount: moneyDtoSchema.refine((value) => value.minorUnits > 0, 'Recurring amount must be positive'),
  description: z.string().max(255).optional(),
  frequency: z.nativeEnum(RecurrenceFrequency),
  startDate: civilDateSchema,
  endDate: civilDateSchema.optional(),
  nextRunAt: civilDateSchema.optional(),
  timeZone: timeZoneSchema,
}).strict();

export type CreateRecurringV1Input = z.infer<typeof createRecurringV1Schema>;

export const recurringV1DtoSchema = z.object({
  id: z.string().uuid(),
  accountId: z.string().uuid(),
  categoryCode: categoryNameSchema,
  amount: moneyDtoSchema,
  description: z.string().nullable(),
  frequency: z.nativeEnum(RecurrenceFrequency),
  startDate: civilDateSchema,
  endDate: civilDateSchema.nullable(),
  nextRunAt: civilDateSchema,
  lastRunDate: civilDateSchema.nullable(),
  timeZone: timeZoneSchema,
  isActive: z.boolean(),
}).strict();

export type RecurringV1Dto = z.infer<typeof recurringV1DtoSchema>;
