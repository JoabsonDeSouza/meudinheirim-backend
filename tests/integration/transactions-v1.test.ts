import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { disposeBootstrapTestDb, getBootstrapTestDb } from '../helpers/db-context.js';

let app: FastifyInstance;
let accountId: string;
let householdId: string;

beforeAll(async () => {
  await getBootstrapTestDb();
  const { setTokenVerifier } = await import('../../src/shared/auth/token-verifier.js');
  const { bootstrapAuthenticatedUser } = await import('../../src/shared/auth/bootstrap.js');
  const { createTestApp } = await import('../helpers/app.js');
  const { prisma } = await import('../../src/shared/db/prisma.js');

  setTokenVerifier({
    verify: async (token: string) => ({ uid: token, email: `${token}@example.com`, emailVerified: true }),
  });
  const user = await bootstrapAuthenticatedUser('tx-v1-owner', 'tx-v1@example.com');
  householdId = user.householdId;
  const account = await prisma.account.create({
    data: {
      householdId,
      name: 'Primary checking',
      type: 'CHECKING',
      currency: 'BRL',
      balance: '100.00',
      totalBalance: '100.00',
      availableBalance: '100.00',
      allocatedBalance: '0.00',
    },
  });
  accountId = account.id;
  app = await createTestApp();
});

afterAll(async () => {
  await app.close();
  await disposeBootstrapTestDb();
});

describe('V1 transaction CRUD and pagination', () => {
  it('creates and reads an exact MoneyDto without decimal numbers', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/v1/transactions',
      headers: { authorization: 'Bearer tx-v1-owner' },
      payload: {
        householdId,
        clientMutationId: '1aa22bb3-cc44-4d55-8e66-123456789abc',
        kind: 'expense',
        amount: { minorUnits: 1234, currency: 'BRL' },
        categoryCode: 'FOOD',
        accountId,
        occurredAt: '2026-10-13T12:34:56.000Z',
        timeZone: 'America/Sao_Paulo',
        note: 'market',
      },
    });
    expect(created.statusCode).toBe(201);
    const body = created.json() as { id: string; amount: { minorUnits: number; currency: string }; note: string };
    expect(body.amount).toEqual({ minorUnits: 1234, currency: 'BRL' });
    expect(body.note).toBe('market');
    const { prisma } = await import('../../src/shared/db/prisma.js');
    const accountAfterExpense = await prisma.account.findUniqueOrThrow({ where: { id: accountId } });
    expect(accountAfterExpense.availableBalance.toFixed(2)).toBe('87.66');

    const listed = await app.inject({
      method: 'GET',
      url: `/v1/transactions?householdId=${householdId}&accountId=${accountId}&limit=10`,
      headers: { authorization: 'Bearer tx-v1-owner' },
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().items).toHaveLength(1);
    expect(listed.json().pagination).toMatchObject({ hasMore: false, nextCursor: null, total: 1 });
  });

  it('filters transactions by type and category code', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/v1/transactions?householdId=${householdId}&kind=expense&categoryCode=FOOD`,
      headers: { authorization: 'Bearer tx-v1-owner' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().items).toHaveLength(1);
  });

  it('paginates with opaque cursors and deterministic order', async () => {
    const createdIds: string[] = [];
    for (const [minorUnits, occurredAt, clientMutationId] of [
      [101, '2026-10-14T10:00:00.000Z', '2bb33cc4-dd55-4e66-9f77-23456789abcd'],
      [202, '2026-10-15T10:00:00.000Z', '3cc44dd5-ee66-4f77-a088-3456789abcde'],
    ] as const) {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/transactions',
        headers: { authorization: 'Bearer tx-v1-owner' },
        payload: {
          householdId,
          clientMutationId,
          kind: 'expense',
          amount: { minorUnits, currency: 'BRL' },
          categoryCode: 'FOOD',
          accountId,
          occurredAt,
          timeZone: 'America/Sao_Paulo',
        },
      });
      expect(response.statusCode).toBe(201);
      createdIds.push((response.json() as { id: string }).id);
    }

    const firstPage = await app.inject({
      method: 'GET',
      url: `/v1/transactions?householdId=${householdId}&limit=1`,
      headers: { authorization: 'Bearer tx-v1-owner' },
    });
    const firstPageBody = firstPage.json() as {
      items: Array<{ id: string }>;
      pagination: { hasMore: boolean; nextCursor: string | null };
    };
    expect(firstPageBody.items).toHaveLength(1);
    expect(firstPageBody.pagination.hasMore).toBe(true);
    expect(firstPageBody.pagination.nextCursor).toBeTruthy();
    expect(firstPageBody.pagination.nextCursor).not.toBe(firstPageBody.items[0].id);

    const nextPage = await app.inject({
      method: 'GET',
      url: `/v1/transactions?householdId=${householdId}&limit=1&cursor=${firstPageBody.pagination.nextCursor}`,
      headers: { authorization: 'Bearer tx-v1-owner' },
    });
    const nextPageBody = nextPage.json() as { items: Array<{ id: string }> };
    expect(nextPageBody.items).toHaveLength(1);
    expect(nextPageBody.items[0].id).not.toBe(firstPageBody.items[0].id);

    for (const [index, transactionId] of createdIds.entries()) {
      await app.inject({
        method: 'DELETE',
        url: `/v1/transactions/${transactionId}?householdId=${householdId}&clientMutationId=${index === 0 ? '6aa77119-22aa-43bb-c4dd-789abcdef012' : '7bb8822a-33bb-44cc-d5ee-89abcdef0123'}&expectedVersion=1`,
        headers: { authorization: 'Bearer tx-v1-owner' },
      });
    }
  });

  it('returns a stable validation error for an invalid cursor', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/v1/transactions?householdId=${householdId}&cursor=invalid`,
      headers: { authorization: 'Bearer tx-v1-owner' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('INVALID_CURSOR');
  });

  it('updates and soft-deletes a transaction', async () => {
    const listed = await app.inject({
      method: 'GET',
      url: `/v1/transactions?householdId=${householdId}&limit=10`,
      headers: { authorization: 'Bearer tx-v1-owner' },
    });
    const transaction = (listed.json() as { items: Array<{ id: string; version: number }> }).items[0];
    const transactionId = transaction.id;
    const updated = await app.inject({
      method: 'PATCH',
      url: `/v1/transactions/${transactionId}`,
      headers: { authorization: 'Bearer tx-v1-owner' },
      payload: {
        clientMutationId: '4dd55ee6-ff77-4088-91aa-456789abcdef',
        expectedVersion: transaction.version,
        note: 'updated market',
      },
    });
    expect(updated.statusCode).toBe(200);
    const updatedTransaction = updated.json() as { note: string; version: number };
    expect(updatedTransaction.note).toBe('updated market');

    const updateReplay = await app.inject({
      method: 'PATCH',
      url: `/v1/transactions/${transactionId}`,
      headers: { authorization: 'Bearer tx-v1-owner' },
      payload: {
        clientMutationId: '4dd55ee6-ff77-4088-91aa-456789abcdef',
        expectedVersion: transaction.version,
        note: 'updated market',
      },
    });
    expect(updateReplay.statusCode).toBe(200);
    expect((updateReplay.json() as { version: number }).version).toBe(updatedTransaction.version);

    const staleUpdate = await app.inject({
      method: 'PATCH',
      url: `/v1/transactions/${transactionId}`,
      headers: { authorization: 'Bearer tx-v1-owner' },
      payload: {
        clientMutationId: '8ff9900a-11bb-42cc-b3dd-89abcdef0123',
        expectedVersion: transaction.version,
        note: 'stale edit',
      },
    });
    expect(staleUpdate.statusCode).toBe(409);
    expect(staleUpdate.json().error.code).toBe('VERSION_CONFLICT');

    const deleted = await app.inject({
      method: 'DELETE',
      url: `/v1/transactions/${transactionId}?clientMutationId=5ee66ff7-0088-4199-a2bb-56789abcdef0&expectedVersion=${updatedTransaction.version}`,
      headers: { authorization: 'Bearer tx-v1-owner' },
    });
    expect(deleted.statusCode).toBe(200);
    const deleteReplay = await app.inject({
      method: 'DELETE',
      url: `/v1/transactions/${transactionId}?clientMutationId=5ee66ff7-0088-4199-a2bb-56789abcdef0&expectedVersion=${updatedTransaction.version}`,
      headers: { authorization: 'Bearer tx-v1-owner' },
    });
    expect(deleteReplay.statusCode).toBe(200);
    expect((deleteReplay.json() as { deletedAt: string | null }).deletedAt).toBeTruthy();
    const afterDelete = await app.inject({
      method: 'GET',
      url: `/v1/transactions?householdId=${householdId}`,
      headers: { authorization: 'Bearer tx-v1-owner' },
    });
    expect((afterDelete.json() as { items: unknown[] }).items).toHaveLength(0);
    const { prisma } = await import('../../src/shared/db/prisma.js');
    const accountAfterDelete = await prisma.account.findUniqueOrThrow({ where: { id: accountId } });
    expect(accountAfterDelete.availableBalance.toFixed(2)).toBe('100.00');
  });
});
