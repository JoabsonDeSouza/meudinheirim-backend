import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Prisma, type PrismaClient } from '../../src/generated/prisma/client.js';

import { disposeBootstrapTestDb, getBootstrapTestDb } from '../helpers/db-context.js';
import type { CreateTransactionV1Input } from '../../src/modules/transactions/transactions.v1.schema.js';

let app: FastifyInstance;
let prisma: PrismaClient;
let householdId: string;
let accountId: string;

beforeAll(async () => {
  await getBootstrapTestDb();
  const { setTokenVerifier } = await import('../../src/shared/auth/token-verifier.js');
  const { bootstrapAuthenticatedUser } = await import('../../src/shared/auth/bootstrap.js');
  const { createTestApp } = await import('../helpers/app.js');
  const prismaModule = await import('../../src/shared/db/prisma.js');
  prisma = prismaModule.prisma;
  setTokenVerifier({
    verify: async (token: string) => ({ uid: token, email: 'sync@example.com', emailVerified: true }),
  });
  const user = await bootstrapAuthenticatedUser('sync-user', 'sync@example.com');
  householdId = user.householdId;
  const account = await prisma.account.create({
    data: {
      householdId,
      name: 'Sync checking',
      type: 'CHECKING',
      currency: 'BRL',
      balance: new Prisma.Decimal('100.00'),
      availableBalance: new Prisma.Decimal('100.00'),
      totalBalance: new Prisma.Decimal('100.00'),
      allocatedBalance: new Prisma.Decimal('0.00'),
    },
  });
  accountId = account.id;
  app = await createTestApp();
});

afterAll(async () => {
  await app.close();
  await disposeBootstrapTestDb();
});

function mutation(clientMutationId: string, minorUnits: number): CreateTransactionV1Input {
  return {
    householdId,
    clientMutationId,
    kind: 'expense',
    amount: { minorUnits, currency: 'BRL' },
    categoryCode: 'FOOD',
    accountId,
    occurredAt: '2026-10-13T12:34:56.000Z',
    timeZone: 'America/Sao_Paulo',
    paid: true,
  };
}

describe('V1 idempotency and change feed', () => {
  it('replays same payload, conflicts on changed payload, and pages tombstones exactly once', async () => {
    const mutationId1 = '5a7cde52-ae08-4ce0-92a4-c6a87127e130';
    const first = await app.inject({ method: 'POST', url: '/v1/transactions', headers: { authorization: 'Bearer sync-user' }, payload: mutation(mutationId1, 1234) });
    const retry = await app.inject({ method: 'POST', url: '/v1/transactions', headers: { authorization: 'Bearer sync-user' }, payload: mutation(mutationId1, 1234) });
    expect(first.statusCode).toBe(201);
    expect(retry.statusCode).toBe(201);
    const firstDto = first.json() as { id: string };
    const retryDto = retry.json() as { id: string };
    expect(retryDto.id).toBe(firstDto.id);
    expect(await prisma.transaction.count({ where: { householdId } })).toBe(1);

    const changedPayload = await app.inject({ method: 'POST', url: '/v1/transactions', headers: { authorization: 'Bearer sync-user' }, payload: mutation(mutationId1, 2000) });
    expect(changedPayload.statusCode).toBe(409);
    expect(changedPayload.json().error.code).toBe('IDEMPOTENCY_CONFLICT');
    let account = await prisma.account.findUniqueOrThrow({ where: { id: accountId } });
    expect(account.availableBalance.toFixed(2)).toBe('87.66');

    const mutationId2 = 'f531b2aa-0083-4f63-b0d1-5f9f1c3bce43';
    const second = await app.inject({ method: 'POST', url: '/v1/transactions', headers: { authorization: 'Bearer sync-user' }, payload: mutation(mutationId2, 500) });
    expect(second.statusCode).toBe(201);
    const secondId = (second.json() as { id: string }).id;

    const mutationId3 = 'e5acba7c-5150-4f4a-9dce-a79fb2f31c11';
    const deleted = await app.inject({
      method: 'DELETE',
      url: `/v1/transactions/${secondId}?householdId=${householdId}&clientMutationId=${mutationId3}&expectedVersion=1`,
      headers: { authorization: 'Bearer sync-user' },
    });
    expect(deleted.statusCode).toBe(200);
    account = await prisma.account.findUniqueOrThrow({ where: { id: accountId } });
    expect(account.availableBalance.toFixed(2)).toBe('87.66');

    const firstPage = await app.inject({
      method: 'GET',
      url: `/v1/sync/changes?householdId=${householdId}&limit=1`,
      headers: { authorization: 'Bearer sync-user' },
    });
    expect(firstPage.statusCode).toBe(200);
    const page1 = firstPage.json() as { items: Array<{ sequence: string; entityId: string; deletedAt: string | null }>; nextCursor: string; hasMore: boolean };
    expect(page1.items).toHaveLength(1);
    expect(page1.hasMore).toBe(true);

    const secondPage = await app.inject({
      method: 'GET',
      url: `/v1/sync/changes?householdId=${householdId}&limit=1&cursor=${page1.nextCursor}`,
      headers: { authorization: 'Bearer sync-user' },
    });
    const page2 = secondPage.json() as { items: Array<{ sequence: string; entityId: string; deletedAt: string | null }>; nextCursor: string; hasMore: boolean };
    expect(page2.items).toHaveLength(1);
    expect(BigInt(page2.items[0].sequence)).toBeGreaterThan(BigInt(page1.items[0].sequence));

    const thirdPage = await app.inject({
      method: 'GET',
      url: `/v1/sync/changes?householdId=${householdId}&limit=1&cursor=${page2.nextCursor}`,
      headers: { authorization: 'Bearer sync-user' },
    });
    const page3 = thirdPage.json() as { items: Array<{ sequence: string; entityId: string; deletedAt: string | null }>; nextCursor: string | null; hasMore: boolean };
    expect(page3.items).toHaveLength(1);
    expect(page3.items[0].entityId).toBe(secondId);
    expect(page3.items[0].deletedAt).not.toBeNull();
    expect(page3.hasMore).toBe(false);
  });

  it('serializes concurrent retries with the same clientMutationId', async () => {
    const id = 'f8123456-789a-4bcd-8e01-23456789abcd';
    const beforeCount = await prisma.transaction.count({ where: { householdId } });
    const beforeBalance = await prisma.account.findUniqueOrThrow({ where: { id: accountId } });
    const input = mutation(id, 200);
    const results = await Promise.all([
      app.inject({ method: 'POST', url: '/v1/transactions', headers: { authorization: 'Bearer sync-user' }, payload: input }),
      app.inject({ method: 'POST', url: '/v1/transactions', headers: { authorization: 'Bearer sync-user' }, payload: input }),
    ]);
    expect(results.map((result) => result.statusCode)).toEqual([201, 201]);
    expect((results[0].json() as { id: string }).id).toBe((results[1].json() as { id: string }).id);
    expect(await prisma.transaction.count({ where: { householdId } })).toBe(beforeCount + 1);
    const afterBalance = await prisma.account.findUniqueOrThrow({ where: { id: accountId } });
    expect(beforeBalance.availableBalance.sub(afterBalance.availableBalance).toFixed(2)).toBe('2.00');
  });
});
