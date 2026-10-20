import { z } from 'zod';
import { InvalidCursorError } from '../errors/index.js';

const syncCursorPayloadSchema = z.object({
  version: z.literal(1),
  sequence: z.string().regex(/^(0|[1-9]\d*)$/),
}).strict();

export function encodeSyncCursor(sequence: bigint): string {
  if (sequence < 0n) throw new RangeError('Sync cursor sequence cannot be negative');
  return Buffer.from(JSON.stringify({ version: 1, sequence: sequence.toString() }), 'utf8').toString('base64url');
}

export function decodeSyncCursor(cursor: string): bigint {
  try {
    if (cursor.length > 256 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error('invalid cursor shape');
    const payload: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    const parsed = syncCursorPayloadSchema.parse(payload);
    const sequence = BigInt(parsed.sequence);
    if (encodeSyncCursor(sequence) !== cursor) throw new Error('non-canonical cursor');
    return sequence;
  } catch {
    throw new InvalidCursorError();
  }
}

export const syncChangesQuerySchema = z.object({
  householdId: z.string().uuid().optional(),
  cursor: z.string().max(256).optional().transform((value) => value === undefined ? 0n : decodeSyncCursor(value)),
  limit: z.coerce.number().int().min(1).max(100).default(50),
}).strict();

export type SyncChangesQuery = z.infer<typeof syncChangesQuerySchema>;
