import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { Prisma } from '../../src/generated/prisma/client.js';

import { disposeBootstrapTestDb, getBootstrapTestDb } from '../helpers/db-context.js';

let app: FastifyInstance;

interface Household {
  readonly token: string;
  readonly householdId: string;
  readonly bankAccountId: string;
  readonly cardAccountId: string;
}

// Each scenario gets its own household so the 3-month baseline and the
// spent-so-far window do not bleed between tests.
async function createHousehold(token: string): Promise<Household> {
  const { setTokenVerifier } = await import('../../src/shared/auth/token-verifier.js');
  const { bootstrapAuthenticatedUser } = await import('../../src/shared/auth/bootstrap.js');
  const { prisma } = await import('../../src/shared/db/prisma.js');
  setTokenVerifier({
    verify: async (incoming: string) => ({ uid: incoming, email: `${incoming}@example.com`, emailVerified: true }),
  });
  const user = await bootstrapAuthenticatedUser(token, `${token}@example.com`);
  const householdId = user.householdId;
  const bank = await prisma.account.create({
    data: { householdId, name: `${token} BRL`, type: 'CHECKING', currency: 'BRL', availableBalance: new Prisma.Decimal('1000.00') },
  });
  const card = await prisma.account.create({
    data: {
      householdId, name: `${token} Card`, type: 'CREDIT', currency: 'BRL',
      availableBalance: new Prisma.Decimal('500.00'), creditLimit: new Prisma.Decimal('5000.00'),
      totalLimit: new Prisma.Decimal('5000.00'), closingDay: 5, dueDay: 15,
    },
  });
  return { token, householdId, bankAccountId: bank.id, cardAccountId: card.id };
}

async function insertExpense(house: Household, accountId: string, amount: string, date: string): Promise<void> {
  const { prisma } = await import('../../src/shared/db/prisma.js');
  await prisma.transaction.create({
    data: {
      id: randomUUID(),
      householdId: house.householdId,
      accountId,
      type: 'EXPENSE',
      amount: new Prisma.Decimal(amount),
      categoryName: 'FOOD',
      date: new Date(`${date}T00:00:00.000Z`),
      occurredAt: new Date(`${date}T12:00:00.000Z`),
      timeZone: 'UTC',
      notes: null,
      paid: true,
      clientMutationId: randomUUID(),
    },
  });
}

beforeAll(async () => {
  await getBootstrapTestDb();
  // Import the Prisma singleton before building the app: createTestApp() rewrites
  // DATABASE_URL to the base URL, and only a client created earlier keeps the isolated DB.
  await import('../../src/shared/db/prisma.js');
  await import('../../src/shared/auth/bootstrap.js');
  const { createTestApp } = await import('../helpers/app.js');
  app = await createTestApp();
});

afterAll(async () => {
  await app.close();
  await disposeBootstrapTestDb();
});

describe('V1 dashboard spending pace', () => {
  it('compares day 1..N against the same window of the previous month, per currency', async () => {
    const house = await createHousehold('pace-user');
    const { prisma } = await import('../../src/shared/db/prisma.js');
    const usd = await prisma.account.create({
      data: { householdId: house.householdId, name: 'pace USD', type: 'CHECKING', currency: 'USD' },
    });
    await insertExpense(house, house.bankAccountId, '100.00', '2026-10-05'); // in window
    await insertExpense(house, house.bankAccountId, '80.00', '2026-09-05'); // previous window
    await insertExpense(house, house.bankAccountId, '999.00', '2026-10-20'); // outside day 10
    await insertExpense(house, usd.id, '25.00', '2026-10-03'); // USD, no previous data

    const response = await app.inject({
      method: 'GET',
      url: `/v1/dashboard/spending-pace?householdId=${house.householdId}&month=2026-10&day=10`,
      headers: { authorization: `Bearer ${house.token}` },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { day: number; previousMonth: string; byCurrency: unknown[] };
    expect(body.day).toBe(10);
    expect(body.previousMonth).toBe('2026-09');
    expect(body.byCurrency).toEqual(expect.arrayContaining([
      {
        currency: 'BRL',
        currentToDate: { minorUnits: 10000, currency: 'BRL' },
        previousToDate: { minorUnits: 8000, currency: 'BRL' },
        changeRatio: 0.25,
      },
      {
        currency: 'USD',
        currentToDate: { minorUnits: 2500, currency: 'USD' },
        previousToDate: { minorUnits: 0, currency: 'USD' },
        changeRatio: null,
      },
    ]));
  });
});

describe('V1 dashboard month forecast', () => {
  it('projects month-end leftover from bank balance, unpaid invoices due by month end, and remaining variable spend', async () => {
    const house = await createHousehold('forecast-user');
    const { prisma } = await import('../../src/shared/db/prisma.js');
    // Baseline (Jul..Sep): 300.00 per month => average 300.00.
    await insertExpense(house, house.bankAccountId, '300.00', '2026-07-15');
    await insertExpense(house, house.bankAccountId, '300.00', '2026-08-15');
    await insertExpense(house, house.bankAccountId, '300.00', '2026-09-15');
    // Spent Oct 1..15 on bank account: 200.00 => remaining variable = 100.00.
    await insertExpense(house, house.bankAccountId, '200.00', '2026-10-10');
    // Unpaid invoice due 2026-10-20 => counts: 150.00.
    await prisma.creditCardInvoice.create({
      data: {
        householdId: house.householdId, cardAccountId: house.cardAccountId, currency: 'BRL',
        periodStart: new Date('2026-09-06T00:00:00.000Z'), periodEnd: new Date('2026-10-05T00:00:00.000Z'),
        dueDate: new Date('2026-10-20T00:00:00.000Z'), status: 'CLOSED', totalAmount: new Prisma.Decimal('150.00'),
      },
    });
    // Invoice due 2026-11-15 => must NOT count for October.
    await prisma.creditCardInvoice.create({
      data: {
        householdId: house.householdId, cardAccountId: house.cardAccountId, currency: 'BRL',
        periodStart: new Date('2026-10-06T00:00:00.000Z'), periodEnd: new Date('2026-11-05T00:00:00.000Z'),
        dueDate: new Date('2026-11-15T00:00:00.000Z'), status: 'OPEN', totalAmount: new Prisma.Decimal('700.00'),
      },
    });

    const response = await app.inject({
      method: 'GET',
      url: `/v1/dashboard/month-forecast?householdId=${house.householdId}&month=2026-10&asOf=2026-10-15`,
      headers: { authorization: `Bearer ${house.token}` },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { asOf: string; byCurrency: Array<Record<string, unknown>> };
    expect(body.asOf).toBe('2026-10-15');
    expect(body.byCurrency).toEqual([{
      currency: 'BRL',
      // Credit card balance (500.00) is excluded; only the bank account (1000.00) counts.
      availableBalance: { minorUnits: 100000, currency: 'BRL' },
      pendingRecurring: { minorUnits: 0, currency: 'BRL' },
      openInvoices: { minorUnits: 15000, currency: 'BRL' },
      variableRemaining: { minorUnits: 10000, currency: 'BRL' },
      // 1000.00 - 0.00 - 150.00 - 100.00 = 750.00
      projectedLeftover: { minorUnits: 75000, currency: 'BRL' },
    }]);
  });

  it('rejects an invalid month and an invalid asOf', async () => {
    const house = await createHousehold('forecast-invalid-user');
    const badMonth = await app.inject({
      method: 'GET',
      url: `/v1/dashboard/month-forecast?householdId=${house.householdId}&month=2026-13`,
      headers: { authorization: `Bearer ${house.token}` },
    });
    expect(badMonth.statusCode).toBe(400);
    const badAsOf = await app.inject({
      method: 'GET',
      url: `/v1/dashboard/month-forecast?householdId=${house.householdId}&month=2026-10&asOf=15-10-2026`,
      headers: { authorization: `Bearer ${house.token}` },
    });
    expect(badAsOf.statusCode).toBe(400);
  });
});
