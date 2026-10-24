import { z } from 'zod';
import { RecurrenceFrequency } from '../../shared/enums/index.js';
import { moneyDtoSchema } from '../../shared/money/index.js';
import { categoryNameSchema } from '../categories/categories.schema.js';

export const recurringKindSchema = z.enum(['FIXED', 'VARIABLE']);
export const recurrenceModeSchema = z.enum(['ONCE', 'LIMITED', 'ALWAYS']);

const timeZoneSchema = z.string().min(1).max(64).refine((value) => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}, 'timeZone must be a valid IANA time zone');

const civilDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}, 'Invalid civil date');

const createRecurringBaseSchema = z.object({
  householdId: z.string().uuid().optional(),
  accountId: z.string().uuid(),
  categoryCode: categoryNameSchema,
  amount: moneyDtoSchema.refine((value) => value.minorUnits > 0, 'Recurring amount must be positive'),
  description: z.string().max(255).optional(),
  frequency: z.nativeEnum(RecurrenceFrequency),
  kind: recurringKindSchema.default('FIXED'),
  recurrenceMode: recurrenceModeSchema.optional(),
  occurrencesLimit: z.number().int().min(1).max(1200).optional(),
  startDate: civilDateSchema,
  endDate: civilDateSchema.optional(),
  nextRunAt: civilDateSchema.optional(),
  timeZone: timeZoneSchema,
}).strict();

function validateCreateRecurring(value: z.infer<typeof createRecurringBaseSchema>, ctx: z.RefinementCtx): void {
  const mode = value.recurrenceMode ?? (value.endDate ? 'LIMITED' : 'ALWAYS');
  if (mode === 'ONCE' && value.occurrencesLimit !== undefined && value.occurrencesLimit !== 1) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['occurrencesLimit'], message: 'ONCE recurrence must have one occurrence' });
  }
  if (mode === 'LIMITED' && value.occurrencesLimit === undefined && value.endDate === undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['occurrencesLimit'], message: 'LIMITED recurrence requires an occurrence limit or end date' });
  }
  if (mode === 'ALWAYS' && (value.occurrencesLimit !== undefined || value.endDate !== undefined)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['recurrenceMode'], message: 'ALWAYS recurrence cannot have a limit or end date' });
  }
  if (value.endDate && value.endDate < value.startDate) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['endDate'], message: 'endDate must be on or after startDate' });
  }
}

export const createRecurringV1Schema = createRecurringBaseSchema.superRefine(validateCreateRecurring);

export type CreateRecurringV1Input = z.infer<typeof createRecurringV1Schema>;
export const createRecurringManagedV1Schema = createRecurringBaseSchema.omit({ nextRunAt: true }).superRefine(validateCreateRecurring);
export type CreateRecurringManagedV1Input = z.infer<typeof createRecurringManagedV1Schema>;

export const updateRecurringV1Schema = z.object({
  accountId: z.string().uuid().optional(),
  categoryCode: categoryNameSchema.optional(),
  amount: moneyDtoSchema.refine((value) => value.minorUnits > 0, 'Recurring amount must be positive').optional(),
  description: z.string().max(255).nullable().optional(),
  frequency: z.nativeEnum(RecurrenceFrequency).optional(),
  kind: recurringKindSchema.optional(),
  recurrenceMode: recurrenceModeSchema.optional(),
  occurrencesLimit: z.number().int().min(1).max(1200).nullable().optional(),
  endDate: civilDateSchema.nullable().optional(),
  timeZone: timeZoneSchema.optional(),
}).strict().refine((value) => Object.keys(value).length > 0, 'At least one field must be provided');

export type UpdateRecurringV1Input = z.infer<typeof updateRecurringV1Schema>;

export const recurringV1IdParamSchema = z.object({ recurringId: z.string().uuid() }).strict();

export const recurringOccurrenceQuerySchema = z.object({
  householdId: z.string().uuid().optional(),
  from: civilDateSchema,
  to: civilDateSchema,
}).strict().refine((value) => value.from <= value.to, 'from must be on or before to');

export const payRecurringOccurrenceSchema = z.object({
  householdId: z.string().uuid().optional(),
  accountId: z.string().uuid().optional(),
  amount: moneyDtoSchema.refine((value) => value.minorUnits > 0, 'Occurrence amount must be positive'),
  clientMutationId: z.string().uuid(),
}).strict();

export type PayRecurringOccurrenceInput = z.infer<typeof payRecurringOccurrenceSchema>;

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

export const recurringManagedV1DtoSchema = recurringV1DtoSchema.extend({
  kind: recurringKindSchema,
  recurrenceMode: recurrenceModeSchema,
  occurrencesLimit: z.number().int().positive().nullable(),
  anchorDay: z.number().int().min(1).max(31),
}).strict();

export type RecurringV1Dto = z.infer<typeof recurringV1DtoSchema>;
export type RecurringManagedV1Dto = z.infer<typeof recurringManagedV1DtoSchema>;
