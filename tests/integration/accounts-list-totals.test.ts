import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Prisma } from '../../src/generated/prisma/client.js';

import { disposeBootstrapTestDb, getBootstrapTestDb } from '../helpers/db-context.js';

let app: FastifyInstance;
let householdId: string;
const token = 'accounts-totals-user';

beforeAll(async () => {
  await getBootstrapTestDb();
  const { setTokenVerifier } = await import('../../src/shared/auth/token-verifier.js');
  const { bootstrapAuthenticatedUser } = await import('../../src/shared/auth/bootstrap.js');
  const { prisma } = await import('../../src/shared/db/prisma.js');
  const { createTestApp } = await import('../helpers/app.js');
  setTokenVerifier({
    verify: async (incoming: string) => ({ uid: incoming, email: `${incoming}@example.com`, emailVerified: true }),
  });
  const user = await bootstrapAuthenticatedUser(token, `${token}@example.com`);
  householdId = user.householdId;

  await prisma.account.createMany({
    data: [
      { householdId, name: 'Checking BRL', type: 'CHECKING', currency: 'BRL', balance: new Prisma.Decimal('1000.00') },
      { householdId, name: 'Cash BRL', type: 'CASH', currency: 'BRL', balance: new Prisma.Decimal('50.00') },
      { householdId, name: 'Invest BRL', type: 'INVESTMENT', currency: 'BRL', balance: new Prisma.Decimal('200.00') },
      // Card balance is the outstanding debt, stored as a positive amount.
      { householdId, name: 'Card BRL', type: 'CREDIT', currency: 'BRL', balance: new Prisma.Decimal('300.00'), creditLimit: new Prisma.Decimal('5000.00'), totalLimit: new Prisma.Decimal('5000.00') },
      { householdId, name: 'Checking USD', type: 'CHECKING', currency: 'USD', balance: new Prisma.Decimal('10.00') },
      { householdId, name: 'Card USD', type: 'CREDIT', currency: 'USD', balance: new Prisma.Decimal('500.00'), creditLimit: new Prisma.Decimal('1000.00'), totalLimit: new Prisma.Decimal('1000.00') },
    ],
  });
  app = await createTestApp();
});

afterAll(async () => {
  await app.close();
  await disposeBootstrapTestDb();
});

describe('GET /v1/accounts totals', () => {
  it('sums non-credit active accounts per currency and never adds credit card balances', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/v1/accounts?householdId=${householdId}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);
    const data = response.json().data as {
      accounts: Array<{ name: string; type: string; balance: number }>;
      totals: Array<{ currency: string; amount: number }>;
    };

    // Each card keeps its own balance in the list.
    expect(data.accounts.find((account) => account.name === 'Card BRL')?.balance).toBe(300);
    expect(data.accounts.find((account) => account.name === 'Card USD')?.balance).toBe(500);

    // Totals: BRL = checking 1000 + cash 50 + investment 200 (existing behaviour kept); card 300 excluded.
    // USD = checking 10 only; card 500 excluded. Currencies are never mixed.
    const totals = Object.fromEntries(data.totals.map((entry) => [entry.currency, entry.amount]));
    expect(totals).toEqual({ BRL: 1250, USD: 10 });
  });
});
