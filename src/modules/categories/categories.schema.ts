import { z } from 'zod';
import {
  CategoryName,
  CategoryType,
  getCategoriesByType,
} from '../../shared/enums/index.js';

/**
 * Category type enum (INCOME or EXPENSE only for custom)
 */
export const categoryTypeEnum = z.nativeEnum(CategoryType);
export const categoryCodeSchema = z.nativeEnum(CategoryName);

export interface SystemCategoryCodeDto {
  readonly code: CategoryName;
  readonly type: CategoryType;
}

export function getSystemCategoryCodes(): SystemCategoryCodeDto[] {
  return [
    ...getCategoriesByType(CategoryType.INCOME).map((code) => ({
      code,
      type: CategoryType.INCOME,
    })),
    ...getCategoriesByType(CategoryType.EXPENSE).map((code) => ({
      code,
      type: CategoryType.EXPENSE,
    })),
  ];
}

/**
 * categoryName: system enum value OR "CUSTOM:<uuid>"
 * Used in Transaction, Budget, RecurringTransaction
 */
export const categoryNameSchema = z.union([
  z.nativeEnum(CategoryName),
  z.string().regex(/^CUSTOM:[0-9a-f-]{36}$/i, 'Invalid custom category id'),
]);
export type CategoryNameInput = z.infer<typeof categoryNameSchema>;

/**
 * Create custom category
 */
export const createCategorySchema = z.object({
  householdId: z.string().uuid().optional(),
  name: z.string().min(1, 'Name is required').max(100, 'Name too long'),
  type: categoryTypeEnum,
  icon: z.string().max(50).optional().nullable(),
  color: z.string().regex(/^#[0-9A-Fa-f]{6}$/, 'Invalid hex color').optional().nullable(),
}).strict();
export type CreateCategoryInput = z.infer<typeof createCategorySchema>;

/**
 * Update custom category (name, icon, color only; type is immutable)
 */
export const updateCategorySchema = z.object({
  name: z.string().min(1).max(100).optional(),
  icon: z.string().max(50).nullable().optional(),
  color: z.string().regex(/^#[0-9A-Fa-f]{6}$/, 'Invalid hex color').nullable().optional(),
}).strict();
export type UpdateCategoryInput = z.infer<typeof updateCategorySchema>;

export const categoryIdParamSchema = z.object({
  categoryId: z.string().uuid(),
}).strict();
export type CategoryIdParam = z.infer<typeof categoryIdParamSchema>;

/**
 * List categories: householdId (optional, defaults to personal), type (optional)
 */
export const listCategoriesQuerySchema = z.object({
  householdId: z.string().uuid().optional(),
  type: categoryTypeEnum.optional(),
}).strict();
export type ListCategoriesQuery = z.infer<typeof listCategoriesQuerySchema>;

/**
 * Description suggestions: householdId (optional, defaults to personal), q (search term, min 2), limit (max 20)
 */
export const descriptionSuggestionsQuerySchema = z.object({
  householdId: z.string().uuid().optional(),
  q: z.string().min(2, 'Search term must be at least 2 characters').max(100),
  limit: z.coerce.number().min(1).max(20).default(5),
}).strict();
export type DescriptionSuggestionsQuery = z.infer<typeof descriptionSuggestionsQuerySchema>;

export interface DescriptionSuggestionDto {
  readonly description: string;
  readonly categoryName: string | null;
  readonly accountId: string | null;
  readonly accountName: string | null;
  readonly count: number;
  readonly lastUsed: string;
  readonly lastAmount: number | null;
}
