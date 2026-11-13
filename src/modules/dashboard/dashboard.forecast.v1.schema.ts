import { z } from 'zod';

const householdQuerySchema = z.object({ householdId: z.string().uuid().optional() }).strict();
const monthSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Month must be a valid YYYY-MM month');

export const dashboardMonthForecastV1QuerySchema = householdQuerySchema.extend({
  month: monthSchema,
  asOf: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'asOf must be YYYY-MM-DD').optional(),
}).strict();

export const dashboardSpendingPaceV1QuerySchema = householdQuerySchema.extend({
  month: monthSchema,
  day: z.coerce.number().int().min(1).max(31).optional(),
}).strict();

export type DashboardMonthForecastV1Query = z.infer<typeof dashboardMonthForecastV1QuerySchema>;
export type DashboardSpendingPaceV1Query = z.infer<typeof dashboardSpendingPaceV1QuerySchema>;
