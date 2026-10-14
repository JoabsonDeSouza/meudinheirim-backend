import { z } from 'zod';
import { AccountType } from '../../shared/enums/index.js';

/**
 * Account types enum
 */
export const accountTypeEnum = z.nativeEnum(AccountType);

/**
 * Create account request
 */
export const createAccountSchema = z.object({
  householdId: z.string().uuid().optional(), // Optional - will create personal household if not provided
  name: z.string().min(1).max(100).trim(),
  type: accountTypeEnum,
  balance: z.coerce.number().default(0),
  currency: z.string().length(3).default('BRL'),
  color: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
  icon: z.string().max(50).optional(),
  creditLimit: z.coerce.number().positive().optional(),
  dueDay: z.number().int().min(1).max(31).optional(),
  closingDay: z.number().int().min(1).max(31).optional(),
  // Number of days before the invoice closes that defines the "best day to buy".
  // Default in service layer is 10 when not provided.
  bestDayOffset: z.number().int().min(1).max(30).optional(),
  linkedAccountId: z.string().uuid().optional(),
}).strict();

export type CreateAccountInput = z.infer<typeof createAccountSchema>;

/**
 * Update account request
 */
export const updateAccountSchema = z.object({
  name: z.string().min(1).max(100).trim().optional(),
  type: accountTypeEnum.optional(),
  balance: z.coerce.number().optional(), // Permitir atualização direta do balance (usado para pagamento de fatura de cartão)
  isActive: z.boolean().optional(),
  color: z.string().regex(/^#[0-9A-Fa-f]{6}$/).nullable().optional(),
  icon: z.string().max(50).nullable().optional(),
  creditLimit: z.coerce.number().positive().nullable().optional(),
  dueDay: z.number().int().min(1).max(31).nullable().optional(),
  closingDay: z.number().int().min(1).max(31).nullable().optional(),
  bestDayOffset: z.number().int().min(1).max(30).nullable().optional(),
  linkedAccountId: z.string().uuid().nullable().optional(),
}).strict();

export type UpdateAccountInput = z.infer<typeof updateAccountSchema>;

/**
 * Account ID param
 */
export const accountIdParamSchema = z.object({
  accountId: z.string().uuid(),
}).strict();

export type AccountIdParam = z.infer<typeof accountIdParamSchema>;

/**
 * List accounts query
 */
export const listAccountsQuerySchema = z.object({
  householdId: z.string().uuid().optional(), // Optional - will use personal household if not provided
  includeInactive: z.coerce.boolean().default(false),
}).strict();

export type ListAccountsQuery = z.infer<typeof listAccountsQuerySchema>;

/**
 * Transfer between accounts
 */
export const transferSchema = z.object({
  fromAccountId: z.string().uuid(),
  toAccountId: z.string().uuid(),
  amount: z.coerce.number().positive('Amount must be positive'),
  description: z.string().max(255).optional(),
}).strict();

export type TransferInput = z.infer<typeof transferSchema>;

/**
 * Adjust balance manually
 */
export const adjustBalanceSchema = z.object({
  newBalance: z.coerce.number(),
  reason: z.string().max(255).optional(),
}).strict();

export type AdjustBalanceInput = z.infer<typeof adjustBalanceSchema>;






