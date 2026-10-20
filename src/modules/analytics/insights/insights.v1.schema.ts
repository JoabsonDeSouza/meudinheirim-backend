import { z } from 'zod';
import { moneyDtoSchema } from '../../../shared/money/index.js';

const timeZoneSchema = z.string().min(1).max(64).refine((value) => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}, 'timeZone must be a valid IANA time zone');

const monthSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Month must be a valid YYYY-MM month');
const householdQuerySchema = z.object({ householdId: z.string().uuid().optional() }).strict();

export const monthlySeriesV1QuerySchema = householdQuerySchema.extend({
  throughMonth: monthSchema,
  timeZone: timeZoneSchema,
}).strict();

export const categoryMovementV1QuerySchema = householdQuerySchema.extend({
  month: monthSchema,
  timeZone: timeZoneSchema,
}).strict();

export const spendingPatternsV1QuerySchema = householdQuerySchema.extend({
  month: monthSchema,
  timeZone: timeZoneSchema,
  currency: z.enum(['BRL', 'USD']),
  smallSpendThresholdMinorUnits: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER),
}).strict();

const monthlyDatumV1Schema = z.object({
  month: monthSchema,
  income: moneyDtoSchema,
  expense: moneyDtoSchema,
  cashFlow: moneyDtoSchema,
}).strict();

export const monthlySeriesV1ResponseSchema = z.object({
  throughMonth: monthSchema,
  timeZone: timeZoneSchema,
  byCurrency: z.array(z.object({
    currency: z.enum(['BRL', 'USD']),
    months: z.array(monthlyDatumV1Schema).length(12),
  }).strict()),
}).strict();

export const categoryMovementV1ResponseSchema = z.object({
  month: monthSchema,
  previousMonth: monthSchema,
  timeZone: timeZoneSchema,
  byCurrency: z.array(z.object({
    currency: z.enum(['BRL', 'USD']),
    movements: z.array(z.object({
      categoryCode: z.string(),
      kind: z.enum(['income', 'expense']),
      currentAmount: moneyDtoSchema,
      previousAmount: moneyDtoSchema,
      change: moneyDtoSchema,
      changeRatio: z.number().nullable(),
    }).strict()),
  }).strict()),
}).strict();

export const spendingPatternsV1ResponseSchema = z.object({
  month: monthSchema,
  currency: z.enum(['BRL', 'USD']),
  timeZone: timeZoneSchema,
  priciestWeekday: z.object({
    weekday: z.number().int().min(0).max(6),
    comparedWeekday: z.number().int().min(0).max(6),
    factor: z.number().positive().nullable(),
  }).strict().nullable(),
  smallSpends: z.object({
    total: moneyDtoSchema,
    count: z.number().int().nonnegative(),
    threshold: moneyDtoSchema,
  }).strict(),
}).strict();

export type MonthlySeriesV1Query = z.infer<typeof monthlySeriesV1QuerySchema>;
export type CategoryMovementV1Query = z.infer<typeof categoryMovementV1QuerySchema>;
export type SpendingPatternsV1Query = z.infer<typeof spendingPatternsV1QuerySchema>;
export type MonthlySeriesV1Response = z.infer<typeof monthlySeriesV1ResponseSchema>;
export type CategoryMovementV1Response = z.infer<typeof categoryMovementV1ResponseSchema>;
export type SpendingPatternsV1Response = z.infer<typeof spendingPatternsV1ResponseSchema>;
