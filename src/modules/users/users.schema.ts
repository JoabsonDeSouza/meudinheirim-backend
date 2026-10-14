import { z } from 'zod';

/**
 * Dashboard widget configuration
 */
export const widgetConfigSchema = z.object({
  id: z.enum([
    'creditCards',
    'trends',
    'forecast',
    'savingsGoals',
    'projectedBalance',
    'balanceEvolution',
    'monthlyComparison',
    'insights',
    'budgetVsRealized',
    'fixedVsVariable',
    'dailyCashFlow',
    'spendingHeatmap',
  ]),
  enabled: z.boolean(),
  order: z.number().int().min(0),
}).strict();

/**
 * Dashboard preferences
 */
export const dashboardPreferencesSchema = z.object({
  widgets: z.array(widgetConfigSchema),
  updatedAt: z.coerce.date().optional(),
}).strict();

/**
 * Update user preferences input
 */
export const updateUserPreferencesSchema = z.object({
  displayName: z.string().min(1).max(100).optional(),
  onboardingCompleted: z.boolean().optional(),
  theme: z.enum(['light', 'dark']).optional(),
  baseCurrency: z.enum(['BRL', 'USD']).optional(),
  locale: z.enum(['pt-BR', 'en-US']).optional(),
  country: z.string().length(2).optional(),
  dashboardPreferences: dashboardPreferencesSchema.optional(),
}).strict();

export type UpdateUserPreferencesInput = z.infer<typeof updateUserPreferencesSchema>;
export type DashboardPreferences = z.infer<typeof dashboardPreferencesSchema>;
export type WidgetConfig = z.infer<typeof widgetConfigSchema>;




