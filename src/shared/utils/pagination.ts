import { z } from 'zod';
import { InvalidCursorError } from '../errors/app-error.js';

const cursorPayloadSchema = z.object({
  version: z.literal(1),
  id: z.string().uuid(),
}).strict();

export function encodeCursor(id: string): string {
  const payload = cursorPayloadSchema.parse({ version: 1, id });
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string): { readonly id: string } {
  try {
    if (cursor.length > 256 || !/^[A-Za-z0-9_-]+$/.test(cursor)) {
      throw new Error('cursor shape invalid');
    }
    const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
    const payload: unknown = JSON.parse(decoded);
    const parsed = cursorPayloadSchema.parse(payload);
    if (encodeCursor(parsed.id) !== cursor) {
      throw new Error('cursor is not canonical');
    }
    return { id: parsed.id };
  } catch {
    throw new InvalidCursorError();
  }
}

/**
 * Pagination query schema for cursor-based pagination
 */
export const paginationSchema = z.object({
  cursor: z.string().max(256).optional().transform((value) =>
    value === undefined ? undefined : decodeCursor(value).id,
  ),
  limit: z.coerce.number().int().min(1).max(100).default(20),
}).strict();

export type PaginationQuery = z.infer<typeof paginationSchema>;

/**
 * Paginated response structure
 */
export interface PaginatedResponse<T> {
  data: T[];
  pagination: {
    nextCursor: string | null;
    hasMore: boolean;
    total?: number;
  };
}

/**
 * Create a paginated response
 */
export function createPaginatedResponse<T extends { id: string }>(
  items: T[],
  limit: number,
  total?: number
): PaginatedResponse<T> {
  const hasMore = items.length > limit;
  const data = hasMore ? items.slice(0, limit) : items;
  const lastId = hasMore ? data[data.length - 1]?.id : undefined;
  const nextCursor = lastId === undefined ? null : encodeCursor(lastId);

  return {
    data,
    pagination: {
      nextCursor,
      hasMore,
      ...(total !== undefined && { total }),
    },
  };
}

/**
 * Build Prisma pagination args for cursor-based pagination
 */
export function buildPaginationArgs(params: PaginationQuery): { skip?: number | undefined; cursor?: { id: string; } | undefined; take: number; } {
  const { cursor, limit } = params;

  return {
    take: limit + 1, // Take one extra to check if there are more
    ...(cursor && {
      skip: 1, // Skip the cursor item
      cursor: { id: cursor },
    }),
  };
}

/**
 * Month filter schema (YYYY-MM format)
 */
export const monthFilterSchema = z.object({
  month: z
    .string()
    .regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Month must be in YYYY-MM format')
    .optional(),
}).strict();

/**
 * Parse month string to date range
 */
export function parseMonthFilter(month: string): { start: Date; end: Date } {
  const [year, monthNum] = month.split('-').map(Number);
  const start = new Date(year!, monthNum! - 1, 1);
  const end = new Date(year!, monthNum!, 0, 23, 59, 59, 999);
  return { start, end };
}





