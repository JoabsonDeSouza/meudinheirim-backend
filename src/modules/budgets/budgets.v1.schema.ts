import { z } from 'zod';
import { moneyDtoSchema } from '../../shared/money/index.js';
import { CategoryType } from '../../shared/enums/index.js';
import { categoryNameSchema } from '../categories/categories.schema.js';

const categoryCodeInputSchema = z.union([categoryNameSchema, z.literal('GENERAL')]);

export const createBudgetV1Schema = z.object({
  householdId: z.string().uuid().optional(),
  categoryCode: categoryCodeInputSchema,
  type: z.nativeEnum(CategoryType),
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
  monthlyLimit: moneyDtoSchema.refine((money) => money.minorUnits > 0, 'Budget limit must be positive'),
}).strict();

export type CreateBudgetV1Input = z.infer<typeof createBudgetV1Schema>;

export const listBudgetsV1QuerySchema = z.object({
  householdId: z.string().uuid().optional(),
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
  type: z.nativeEnum(CategoryType).optional(),
  currency: z.enum(['BRL', 'USD']).optional(),
}).strict();

export type ListBudgetsV1Query = z.infer<typeof listBudgetsV1QuerySchema>;
