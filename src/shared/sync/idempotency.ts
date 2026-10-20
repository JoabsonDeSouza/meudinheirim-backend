import { createHash } from 'node:crypto';
import type { z } from 'zod';
import type { Prisma } from '../../generated/prisma/client.js';
import { IdempotencyConflictError } from '../errors/index.js';

export function payloadHash(payload: unknown): string {
  return createHash('sha256').update(canonicalJson(payload)).digest('hex');
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(normalize(value));
}

function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize);
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
    return Object.fromEntries(entries.map(([key, item]) => [key, normalize(item)]));
  }
  return value;
}

export interface MutationIdentity {
  readonly userId: string;
  readonly clientMutationId: string;
  readonly hash: string;
}

/** Must be called inside the transaction that performs the mutation. */
export async function findMutationReplay<T>(
  tx: Prisma.TransactionClient,
  identity: MutationIdentity,
  responseSchema: z.ZodType<T>,
): Promise<T | null> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`mutation:${identity.userId}:${identity.clientMutationId}`}))`;
  const receipt = await tx.syncMutation.findUnique({
    where: {
      userId_clientMutationId: {
        userId: identity.userId,
        clientMutationId: identity.clientMutationId,
      },
    },
  });
  if (!receipt) return null;
  if (receipt.payloadHash !== identity.hash) throw new IdempotencyConflictError();
  return responseSchema.parse(receipt.response);
}

export async function saveMutationReceipt(
  tx: Prisma.TransactionClient,
  identity: MutationIdentity,
  entityType: string,
  entityId: string,
  response: unknown,
): Promise<void> {
  const jsonResponse = response as Prisma.InputJsonValue;
  await tx.syncMutation.create({
    data: {
      userId: identity.userId,
      clientMutationId: identity.clientMutationId,
      payloadHash: identity.hash,
      entityType,
      entityId,
      response: jsonResponse,
    },
  });
}

export async function appendSyncChange(
  tx: Prisma.TransactionClient,
  change: {
    readonly householdId: string;
    readonly entityType: string;
    readonly entityId: string;
    readonly version: number;
    readonly payload: unknown;
    readonly deletedAt?: Date | null;
  },
): Promise<bigint> {
  const payload = change.payload as Prisma.InputJsonValue;
  const row = await tx.syncChange.create({
    data: {
      householdId: change.householdId,
      entityType: change.entityType,
      entityId: change.entityId,
      version: change.version,
      payload,
      deletedAt: change.deletedAt ?? null,
    },
    select: { sequence: true },
  });
  return row.sequence;
}
