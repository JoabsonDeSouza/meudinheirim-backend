import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Prisma } from '../../src/generated/prisma/client.js';

import { disposeBootstrapTestDb, getBootstrapTestDb } from '../helpers/db-context.js';

let app: FastifyInstance;
let token: string;
let householdId: string;
let usdAccountId: string;

beforeAll(async () => {
  await getBootstrapTestDb();
  const { setTokenVerifier } = await import('../../src/shared/auth/token-verifier.js');
  const { bootstrapAuthenticatedUser } = await import('../../src/shared/auth/bootstrap.js');
  const { prisma } = await import('../../src/shared/db/prisma.js');
  const { createTestApp } = await import('../helpers/app.js');
  setTokenVerifier({
    verify: async (incoming: string) => ({ uid: incoming, email: `${incoming}@example.com`, emailVerified: true }),
  });
  token = 'savings-goals-user';
  const user = await bootstrapAuthenticatedUser(token, `${token}@example.com`);
  householdId = user.householdId;
  const usd = await prisma.account.create({
    data: { householdId, name: 'Goals USD', type: 'CHECKING', currency: 'USD' },
  });
  usdAccountId = usd.id;
  app = await createTestApp();
});

afterAll(async () => {
  await app.close();
  await disposeBootstrapTestDb();
});

describe('V1 savings goals read model', () => {
  it('derives currency from the linked account and estimates pace from months since creation', async () => {
    const { prisma } = await import('../../src/shared/db/prisma.js');
    // Created three calendar months ago, so monthsElapsed is exactly 3.
    const created = new Date();
    created.setUTCDate(15);
    created.setUTCMonth(created.getUTCMonth() - 3);

    await prisma.savingsGoal.create({
      data: {
        householdId, accountId: usdAccountId, name: 'Viagem',
        targetAmount: new Prisma.Decimal('6000.00'), currentAmount: new Prisma.Decimal('2400.00'),
        createdAt: created,
      },
    });
    await prisma.savingsGoal.create({
      data: {
        householdId, name: 'Sem conta',
        targetAmount: new Prisma.Decimal('1000.00'), currentAmount: new Prisma.Decimal('0.00'),
        createdAt: created,
      },
    });

    const response = await app.inject({
      method: 'GET',
      url: `/v1/savings-goals?householdId=${householdId}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);
    const items = (response.json() as { data: Array<Record<string, unknown>> }).data;
    const viagem = items.find((item) => item.name === 'Viagem');
    const semConta = items.find((item) => item.name === 'Sem conta');

    expect(viagem).toMatchObject({
      currency: 'USD',
      targetAmount: 6000,
      currentAmount: 2400,
      remaining: 3600,
      percentage: 40,
      isCompleted: false,
      monthsElapsed: 3,
      monthlyPace: 800,
      estimatedMonthsRemaining: 4.5,
    });
    expect(semConta).toMatchObject({
      currency: 'BRL',
      monthsElapsed: 3,
      monthlyPace: 0,
      estimatedMonthsRemaining: null,
    });
    // Goal rows must not leak the joined account object.
    expect(viagem).not.toHaveProperty('account');
  });
});
