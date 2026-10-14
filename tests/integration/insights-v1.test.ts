import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Prisma } from '../../src/generated/prisma/client.js';

import { disposeBootstrapTestDb, getBootstrapTestDb } from '../helpers/db-context.js';

let app: FastifyInstance;
let householdId: string;
let brlAccountId: string;
let usdAccountId: string;
let nextId = 0;

beforeAll(async () => {
  await getBootstrapTestDb();
  const { setTokenVerifier } = await import('../../src/shared/auth/token-verifier.js');
  const { bootstrapAuthenticatedUser } = await import('../../src/shared/auth/bootstrap.js');
  const { createTestApp } = await import('../helpers/app.js');
  const { prisma } = await import('../../src/shared/db/prisma.js');
  setTokenVerifier({
    verify: async (token: string) => ({ uid: token, email: `${token}@example.com`, emailVerified: true }),
  });
  const user = await bootstrapAuthenticatedUser('insights-v1-user', 'insights-v1-user@example.com');
  householdId = user.householdId;
  const [brlAccount, usdAccount] = await Promise.all([
    prisma.account.create({ data: { householdId, name: 'Insights BRL', type: 'CHECKING', currency: 'BRL' } }),
    prisma.account.create({ data: { householdId, name: 'Insights USD', type: 'CHECKING', currency: 'USD' } }),
  ]);
  brlAccountId = brlAccount.id;
  usdAccountId = usdAccount.id;
  app = await createTestApp();
});

afterAll(async () => {
  await app.close();
  await disposeBootstrapTestDb();
});

beforeEach(async () => {
  const { prisma } = await import('../../src/shared/db/prisma.js');
  await prisma.transaction.deleteMany({ where: { householdId } });
});

async function insertTransaction(input: {
  readonly accountId: string;
  readonly amount: string;
  readonly categoryCode: string;
  readonly occurredAt: string;
  readonly type: 'INCOME' | 'EXPENSE';
}): Promise<void> {
  const { prisma } = await import('../../src/shared/db/prisma.js');
  nextId += 1;
  const occurredAt = new Date(input.occurredAt);
  await prisma.transaction.create({
    data: {
      householdId,
      accountId: input.accountId,
      type: input.type,
      amount: new Prisma.Decimal(input.amount),
      categoryName: input.categoryCode,
      date: new Date(`${occurredAt.toISOString().slice(0, 10)}T00:00:00.000Z`),
      occurredAt,
      timeZone: 'America/Los_Angeles',
      paid: true,
      clientMutationId: `41234567-89ab-4cde-8f01-${String(nextId).padStart(12, '0')}`,
    },
  });
}

const headers = { authorization: 'Bearer insights-v1-user' };

describe('V1 derived insights', () => {
  it('returns twelve timezone-bucketed months, fills missing months with zero, and derives cash flow per currency', async () => {
    await insertTransaction({
      accountId: brlAccountId, amount: '50.00', categoryCode: 'SALARY', type: 'INCOME', occurredAt: '2026-03-01T07:30:00.000Z',
    });
    await insertTransaction({
      accountId: brlAccountId, amount: '100.00', categoryCode: 'SALARY', type: 'INCOME', occurredAt: '2026-03-08T10:30:00.000Z',
    });
    await insertTransaction({
      accountId: brlAccountId, amount: '25.00', categoryCode: 'FOOD', type: 'EXPENSE', occurredAt: '2026-03-08T09:30:00.000Z',
    });
    await insertTransaction({
      accountId: usdAccountId, amount: '5.00', categoryCode: 'FOOD', type: 'EXPENSE', occurredAt: '2026-03-08T10:30:00.000Z',
    });

    const response = await app.inject({
      method: 'GET',
      url: `/v1/insights/monthly-series?householdId=${householdId}&throughMonth=2026-03&timeZone=America%2FLos_Angeles`,
      headers,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      byCurrency: Array<{
        currency: string;
        months: Array<{ month: string; income: { minorUnits: number }; expense: { minorUnits: number }; cashFlow: { minorUnits: number } }>;
      }>;
    };
    expect(body.byCurrency.map(({ currency }) => currency)).toEqual(['BRL', 'USD']);
    const brlMonths = body.byCurrency[0]?.months ?? [];
    expect(brlMonths).toHaveLength(12);
    expect(brlMonths[0]).toMatchObject({ month: '2025-04', income: { minorUnits: 0 }, expense: { minorUnits: 0 }, cashFlow: { minorUnits: 0 } });
    expect(brlMonths[10]).toMatchObject({ month: '2026-02', income: { minorUnits: 5000 }, expense: { minorUnits: 0 }, cashFlow: { minorUnits: 5000 } });
    expect(brlMonths[11]).toMatchObject({ month: '2026-03', income: { minorUnits: 10000 }, expense: { minorUnits: 2500 }, cashFlow: { minorUnits: 7500 } });
    expect(body.byCurrency[1]?.months[11]).toMatchObject({ month: '2026-03', income: { minorUnits: 0 }, expense: { minorUnits: 500 }, cashFlow: { minorUnits: -500 } });
  });

  it('computes category deltas and returns null percentage change when the prior amount is zero', async () => {
    await insertTransaction({
      accountId: brlAccountId, amount: '10.00', categoryCode: 'FOOD', type: 'EXPENSE', occurredAt: '2026-02-10T20:00:00.000Z',
    });
    await insertTransaction({
      accountId: brlAccountId, amount: '15.00', categoryCode: 'FOOD', type: 'EXPENSE', occurredAt: '2026-03-10T20:00:00.000Z',
    });
    await insertTransaction({
      accountId: brlAccountId, amount: '5.00', categoryCode: 'TRAVEL', type: 'EXPENSE', occurredAt: '2026-03-11T20:00:00.000Z',
    });
    await insertTransaction({
      accountId: usdAccountId, amount: '5.00', categoryCode: 'FOOD', type: 'EXPENSE', occurredAt: '2026-03-12T20:00:00.000Z',
    });

    const response = await app.inject({
      method: 'GET',
      url: `/v1/insights/category-movement?householdId=${householdId}&month=2026-03&timeZone=America%2FLos_Angeles`,
      headers,
    });
    expect(response.statusCode).toBe(200);
    const rows = response.json().byCurrency[0].movements as Array<{
      categoryCode: string;
      change: { minorUnits: number };
      changeRatio: number | null;
    }>;
    expect(rows.find((row) => row.categoryCode === 'FOOD')).toMatchObject({ change: { minorUnits: 500 }, changeRatio: 0.5 });
    expect(rows.find((row) => row.categoryCode === 'TRAVEL')).toMatchObject({ change: { minorUnits: 500 }, changeRatio: null });
    expect(response.json().byCurrency[1]).toMatchObject({
      currency: 'USD',
      movements: [{ categoryCode: 'FOOD', currentAmount: { minorUnits: 500, currency: 'USD' }, changeRatio: null }],
    });
  });

  it('uses average daily spend by weekday and counts only spends strictly below the required threshold', async () => {
    for (const day of [6, 13, 20, 27]) {
      await insertTransaction({
        accountId: brlAccountId, amount: '30.00', categoryCode: 'FOOD', type: 'EXPENSE', occurredAt: `2026-03-${String(day).padStart(2, '0')}T20:00:00.000Z`,
      });
    }
    await insertTransaction({
      accountId: brlAccountId, amount: '2.50', categoryCode: 'FOOD', type: 'EXPENSE', occurredAt: '2026-03-08T07:30:00.000Z',
    });
    await insertTransaction({
      accountId: brlAccountId, amount: '3.00', categoryCode: 'FOOD', type: 'EXPENSE', occurredAt: '2026-03-08T10:30:00.000Z',
    });
    await insertTransaction({
      accountId: brlAccountId, amount: '3.01', categoryCode: 'FOOD', type: 'EXPENSE', occurredAt: '2026-03-09T10:30:00.000Z',
    });

    const response = await app.inject({
      method: 'GET',
      url: `/v1/insights/spending-patterns?householdId=${householdId}&month=2026-03&timeZone=America%2FLos_Angeles&currency=BRL&smallSpendThresholdMinorUnits=300`,
      headers,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      smallSpends: { total: { minorUnits: 250, currency: 'BRL' }, count: 1, threshold: { minorUnits: 300, currency: 'BRL' } },
      priciestWeekday: { weekday: 5, comparedWeekday: 2, factor: null },
    });
  });

  it('compares average daily spend per weekday rather than raw weekday totals', async () => {
    for (let day = 1; day <= 31; day += 1) {
      const weekday = new Date(`2026-03-${String(day).padStart(2, '0')}T00:00:00.000Z`).getUTCDay();
      await insertTransaction({
        accountId: brlAccountId,
        amount: weekday === 2 ? '0.50' : '1.00',
        categoryCode: 'FOOD',
        type: 'EXPENSE',
        occurredAt: `2026-03-${String(day).padStart(2, '0')}T12:00:00.000Z`,
      });
    }
    await insertTransaction({
      accountId: brlAccountId,
      amount: '8.00',
      categoryCode: 'FOOD',
      type: 'EXPENSE',
      occurredAt: '2026-03-06T12:00:00.000Z',
    });

    const response = await app.inject({
      method: 'GET',
      url: `/v1/insights/spending-patterns?householdId=${householdId}&month=2026-03&timeZone=UTC&currency=BRL&smallSpendThresholdMinorUnits=10000`,
      headers,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().priciestWeekday).toEqual({ weekday: 5, comparedWeekday: 2, factor: 6 });
  });

  it('rejects a missing or non-positive small-spend threshold', async () => {
    const missing = await app.inject({
      method: 'GET',
      url: `/v1/insights/spending-patterns?householdId=${householdId}&month=2026-03&timeZone=UTC&currency=BRL`,
      headers,
    });
    expect(missing.statusCode).toBe(400);
    const nonPositive = await app.inject({
      method: 'GET',
      url: `/v1/insights/spending-patterns?householdId=${householdId}&month=2026-03&timeZone=UTC&currency=BRL&smallSpendThresholdMinorUnits=0`,
      headers,
    });
    expect(nonPositive.statusCode).toBe(400);
  });
});
