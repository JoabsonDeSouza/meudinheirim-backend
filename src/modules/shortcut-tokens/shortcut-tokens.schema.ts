import { z } from 'zod';
import { moneyDtoSchema } from '../../shared/money/index.js';
import { categoryNameSchema } from '../categories/categories.schema.js';

export const SHORTCUT_SCOPE_TRANSACTIONS_CREATE = 'transactions:create' as const;

/** Default per-token ceiling, in minor units of the transaction currency (R$ 1.000,00 / US$ 1,000.00). */
export const SHORTCUT_DEFAULT_MAX_AMOUNT_MINOR = 100_000;

/** Maximum active (non-revoked) tokens per user. */
export const SHORTCUT_MAX_ACTIVE_TOKENS_PER_USER = 5;

/** Requests per minute per token on the transaction endpoint. */
export const SHORTCUT_RATE_LIMIT_PER_MINUTE = 30;

export const createShortcutTokenSchema = z.object({
  deviceName: z.string().trim().min(1).max(60),
  scopes: z.array(z.literal(SHORTCUT_SCOPE_TRANSACTIONS_CREATE)).length(1),
  householdId: z.string().uuid().optional(),
}).strict();

export type CreateShortcutTokenInput = z.infer<typeof createShortcutTokenSchema>;

export const shortcutTokenIdParamSchema = z.object({
  tokenId: z.string().uuid(),
}).strict();

const timeZoneSchema = z.string().min(1).max(64).refine((value) => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}, 'timeZone must be a valid IANA time zone');

const FUTURE_TOLERANCE_MS = 5 * 60 * 1000;

/**
 * Body accepted by POST /v1/shortcut/transactions. Strict: only expenses, always paid.
 * The amount ceiling is checked against the token, not here.
 */
export const shortcutTransactionSchema = z.object({
  householdId: z.string().uuid().optional(),
  clientMutationId: z.string().uuid(),
  kind: z.literal('expense'),
  amount: moneyDtoSchema.refine((money) => money.minorUnits > 0, 'Transaction amount must be positive'),
  categoryCode: categoryNameSchema,
  accountId: z.string().uuid(),
  occurredAt: z.string().datetime().refine(
    (value) => new Date(value).getTime() <= Date.now() + FUTURE_TOLERANCE_MS,
    'occurredAt cannot be more than 5 minutes in the future',
  ),
  timeZone: timeZoneSchema,
  note: z.string().max(1000).optional(),
  paid: z.literal(true),
}).strict();

export type ShortcutTransactionInput = z.infer<typeof shortcutTransactionSchema>;
