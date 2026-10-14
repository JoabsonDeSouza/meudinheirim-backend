import type { Prisma } from '../../generated/prisma/client.js';
import { encodeSyncCursor, type SyncChangesQuery } from '../../shared/sync/cursor.js';
import { prisma } from '../../shared/db/prisma.js';

export interface SyncChangeDto {
  readonly sequence: string;
  readonly entityType: string;
  readonly entityId: string;
  readonly version: number;
  readonly payload: Prisma.JsonValue;
  readonly deletedAt: string | null;
  readonly createdAt: string;
}

export interface SyncChangesPage {
  readonly items: readonly SyncChangeDto[];
  readonly nextCursor: string;
  readonly hasMore: boolean;
}

export async function listSyncChanges(
  query: SyncChangesQuery,
  householdId: string,
): Promise<SyncChangesPage> {
  const rows = await prisma.syncChange.findMany({
    where: {
      householdId,
      sequence: { gt: query.cursor },
    },
    orderBy: { sequence: 'asc' },
    take: query.limit + 1,
  });
  const hasMore = rows.length > query.limit;
  const page = hasMore ? rows.slice(0, query.limit) : rows;
  const lastSequence = page.length > 0 ? page[page.length - 1].sequence : query.cursor;
  return {
    items: page.map((row) => ({
      sequence: row.sequence.toString(),
      entityType: row.entityType,
      entityId: row.entityId,
      version: row.version,
      payload: row.payload,
      deletedAt: row.deletedAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
    })),
    nextCursor: encodeSyncCursor(lastSequence),
    hasMore,
  };
}
