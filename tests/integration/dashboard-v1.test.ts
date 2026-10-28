import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Prisma } from '../../src/generated/prisma/client.js';

import { disposeBootstrapTestDb, getBootstrapTestDb } from '../helpers/db-context.js';

let app: FastifyInstance;
let householdId: string;
let brlAccountId: string;
let usdAccountId: string;

beforeAll(async () => {
  await getBootstrapTestDb();
  const { setTokenVerifier } = await import('../../src/shared/auth/token-verifier.js');
  const { bootstrapAuthenticatedUser } = await import('../../src/shared/auth/bootstrap.js');
  const { createTestApp } = await import('../helpers/app.js');
  const { prisma } = await import('../../src/shared/db/prisma.js');
  setTokenVerifier({
    verify: async (token: string) => ({ uid: token, email: `${token}@example.com`, emailVerified: true }),
  });
  const user = await bootstrapAuthenticatedUser('dashboard-v1-user', 'dashboard-v1-user@example.com');
  householdId = user.householdId;
  const [brlAccount, usdAccount] = await Promise.all([
    prisma.account.create({ data: { householdId, name: 'Dashboard BRL', type: 'CHECKING', currency: 'BRL' } }),
    prisma.account.create({ data: { householdId, name: 'Dashboard USD', type: 'CHECKING', currency: 'USD' } }),
  ]);
  brlAccountId = brlAccount.id;
  usdAccountId = usdAccount.id;
  app = await createTestApp();
});

afterAll(async () => {
  await app.close();
  await disposeBootstrapTestDb();
});

function uuidAt(prefix: string, index: number): string {
  return `${prefix}-0000-4000-8000-${String(index).padStart(12, '0')}`;
}

async function insertTransaction(input: {
  readonly id: string;
  readonly accountId: string | null;
  readonly amount: string;
  readonly categoryName: string | null;
  readonly clientMutationId: string;
  readonly occurredAt: Date;
  readonly type: 'INCOME' | 'EXPENSE' | 'TRANSFER';
  readonly fromAccountId?: string;
  readonly toAccountId?: string;
  readonly installmentId?: string;
  readonly installmentNumber?: number;
  readonly totalInstallments?: number;
  readonly installmentTotalAmount?: string;
}): Promise<void> {
  const { prisma } = await import('../../src/shared/db/prisma.js');
  await prisma.transaction.create({
    data: {
      id: input.id,
      householdId,
      accountId: input.accountId,
      type: input.type,
      amount: new Prisma.Decimal(input.amount),
      categoryName: input.categoryName,
      date: new Date(`${input.occurredAt.toISOString().slice(0, 10)}T00:00:00.000Z`),
      occurredAt: input.occurredAt,
      timeZone: 'UTC',
      notes: null,
      paid: true,
      clientMutationId: input.clientMutationId,
      ...(input.installmentId ? {
        installmentId: input.installmentId,
        installmentNumber: input.installmentNumber,
        totalInstallments: input.totalInstallments,
        installmentTotalAmount: new Prisma.Decimal(input.installmentTotalAmount!),
      } : {}),
      ...(input.fromAccountId ? { fromAccountId: input.fromAccountId } : {}),
      ...(input.toAccountId ? { toAccountId: input.toAccountId } : {}),
    },
  });
}

describe('V1 dashboard', () => {
  it('returns currency-separated totals, excludes transfers, and orders the latest ten deterministically', async () => {
    const sameInstant = new Date('2026-10-14T10:00:00.000Z');
    await insertTransaction({
      id: uuidAt('10000000', 1), accountId: brlAccountId, amount: '100.00', categoryName: 'SALARY',
      clientMutationId: uuidAt('30000000', 1), occurredAt: sameInstant, type: 'INCOME',
    });
    for (let index = 1; index <= 12; index += 1) {
      await insertTransaction({
        id: uuidAt('20000000', index), accountId: brlAccountId, amount: '1.00', categoryName: 'FOOD',
        clientMutationId: uuidAt('30000000', index + 1), occurredAt: sameInstant, type: 'EXPENSE',
      });
    }
    await insertTransaction({
      id: uuidAt('10000000', 2), accountId: usdAccountId, amount: '25.00', categoryName: 'FOOD',
      clientMutationId: uuidAt('30000000', 20), occurredAt: sameInstant, type: 'EXPENSE',
    });
    await insertTransaction({
      id: uuidAt('05000000', 1), accountId: null, amount: '50.00', categoryName: null,
      clientMutationId: uuidAt('30000000', 21), occurredAt: new Date('2026-10-14T11:00:00.000Z'),
      type: 'TRANSFER', fromAccountId: brlAccountId, toAccountId: brlAccountId,
    });

    const headers = { authorization: 'Bearer dashboard-v1-user' };
    const overview = await app.inject({
      method: 'GET',
      url: `/v1/dashboard/overview?householdId=${householdId}&month=2026-10`,
      headers,
    });
    expect(overview.statusCode).toBe(200);
    expect(overview.json()).toEqual({
      month: '2026-10',
      byCurrency: [
        {
          currency: 'BRL',
          income: { minorUnits: 10000, currency: 'BRL' },
          expense: { minorUnits: 1200, currency: 'BRL' },
          balance: { minorUnits: 8800, currency: 'BRL' },
        },
        {
          currency: 'USD',
          income: { minorUnits: 0, currency: 'USD' },
          expense: { minorUnits: 2500, currency: 'USD' },
          balance: { minorUnits: -2500, currency: 'USD' },
        },
      ],
    });

    const recent = await app.inject({
      method: 'GET',
      url: `/v1/dashboard/recent-transactions?householdId=${householdId}`,
      headers,
    });
    expect(recent.statusCode).toBe(200);
    const recentItems = recent.json().items as Array<{ id: string; kind: string; amount: { currency: string } }>;
    expect(recentItems).toHaveLength(10);
    expect(recentItems[0]).toMatchObject({ id: uuidAt('05000000', 1), kind: 'transfer', amount: { currency: 'BRL' } });
    expect(recentItems.slice(1).map((item) => item.id)).toEqual(
      Array.from({ length: 9 }, (_, index) => uuidAt('20000000', 12 - index)),
    );
  });

  it('returns zero totals by each account currency when the requested month has no activity', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/v1/dashboard/overview?householdId=${householdId}&month=2026-09`,
      headers: { authorization: 'Bearer dashboard-v1-user' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().byCurrency).toEqual([
      { currency: 'BRL', income: { minorUnits: 0, currency: 'BRL' }, expense: { minorUnits: 0, currency: 'BRL' }, balance: { minorUnits: 0, currency: 'BRL' } },
      { currency: 'USD', income: { minorUnits: 0, currency: 'USD' }, expense: { minorUnits: 0, currency: 'USD' }, balance: { minorUnits: 0, currency: 'USD' } },
    ]);
  });

  it('returns persisted installment grouping metadata and original total on recent activities', async () => {
    const installmentId = uuidAt('40000000', 1);
    const occurredAt = new Date('2026-10-15T10:00:00.000Z');
    for (const [index, amount] of ['40.00', '40.00'].entries()) {
      await insertTransaction({
        id: uuidAt('50000000', index + 1),
        accountId: brlAccountId,
        amount,
        categoryName: 'RESTAURANT',
        clientMutationId: uuidAt('60000000', index + 1),
        occurredAt,
        type: 'EXPENSE',
        installmentId,
        installmentNumber: index + 1,
        totalInstallments: 5,
        installmentTotalAmount: '200.00',
      });
    }

    const response = await app.inject({
      method: 'GET',
      url: `/v1/dashboard/recent-transactions?householdId=${householdId}`,
      headers: { authorization: 'Bearer dashboard-v1-user' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().items.slice(0, 2)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        installmentId,
        installmentNumber: 1,
        totalInstallments: 5,
        amount: { minorUnits: 4000, currency: 'BRL' },
        installmentTotalAmount: { minorUnits: 20000, currency: 'BRL' },
      }),
      expect.objectContaining({ installmentId, installmentNumber: 2 }),
    ]));
  });
});
