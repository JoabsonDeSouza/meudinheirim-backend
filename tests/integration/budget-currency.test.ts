import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { disposeBootstrapTestDb, getBootstrapTestDb } from '../helpers/db-context.js';

let app: FastifyInstance;
type InjectResponse = Awaited<ReturnType<FastifyInstance['inject']>>;
let householdId: string;
let brlAccountId: string;
let usdAccountId: string;

beforeAll(async () => {
  await getBootstrapTestDb();
  const { setTokenVerifier } = await import('../../src/shared/auth/token-verifier.js');
  const { bootstrapAuthenticatedUser } = await import('../../src/shared/auth/bootstrap.js');
  const { createTestApp } = await import('../helpers/app.js');
  setTokenVerifier({
    verify: async (token: string) => ({ uid: token, email: 'budget@example.com', emailVerified: true }),
  });
  const user = await bootstrapAuthenticatedUser('budget-user', 'budget@example.com');
  householdId = user.householdId;
  app = await createTestApp();
});

afterAll(async () => {
  await app.close();
  await disposeBootstrapTestDb();
});

describe('V1 budget currency isolation', () => {
  it('returns separate BRL and USD budgets and realized spending', async () => {
    const brlAccount = await app.inject({
      method: 'POST',
      url: '/v1/accounts',
      headers: { authorization: 'Bearer budget-user' },
      payload: { householdId, name: 'BRL account', type: 'CHECKING', currency: 'BRL' },
    });
    const usdAccount = await app.inject({
      method: 'POST',
      url: '/v1/accounts',
      headers: { authorization: 'Bearer budget-user' },
      payload: { householdId, name: 'USD account', type: 'CHECKING', currency: 'USD' },
    });
    expect(brlAccount.statusCode).toBe(201);
    expect(usdAccount.statusCode).toBe(201);
    brlAccountId = (brlAccount.json() as { data: { id: string } }).data.id;
    usdAccountId = (usdAccount.json() as { data: { id: string } }).data.id;

    const addExpense = async (accountId: string, currency: 'BRL' | 'USD', minorUnits: number, clientMutationId: string): Promise<InjectResponse> =>
      app.inject({
        method: 'POST',
        url: '/v1/transactions',
        headers: { authorization: 'Bearer budget-user' },
        payload: {
          householdId,
          clientMutationId,
          kind: 'expense',
          amount: { minorUnits, currency },
          categoryCode: 'FOOD',
          accountId,
          occurredAt: '2026-10-12T12:00:00.000Z',
          timeZone: 'America/Sao_Paulo',
          paid: true,
        },
      });

    expect((await addExpense(brlAccountId, 'BRL', 1500, 'a1234567-89ab-4cde-8f01-23456789abcd')).statusCode).toBe(201);
    expect((await addExpense(usdAccountId, 'USD', 2000, 'b2345678-9abc-4def-8012-3456789abcde')).statusCode).toBe(201);

    const createBudget = async (currency: 'BRL' | 'USD', minorUnits: number): Promise<InjectResponse> =>
      app.inject({
        method: 'POST',
        url: '/v1/budgets',
        headers: { authorization: 'Bearer budget-user' },
        payload: {
          householdId,
          categoryCode: 'FOOD',
          type: 'EXPENSE',
          month: '2026-10',
          monthlyLimit: { minorUnits, currency },
        },
      });

    expect((await createBudget('BRL', 10000)).statusCode).toBe(201);
    const usdBudget = await createBudget('USD', 20000);
    expect(usdBudget.statusCode).toBe(201);

    const response = await app.inject({
      method: 'GET',
      url: `/v1/budgets?householdId=${householdId}&month=2026-10`,
      headers: { authorization: 'Bearer budget-user' },
    });
    expect(response.statusCode).toBe(200);
    const items = (response.json() as { items: Array<{ currency: string; monthlyLimit: { minorUnits: number; currency: string }; spent: { minorUnits: number; currency: string } }> }).items;
    expect(items).toHaveLength(2);
    expect(items.map((item) => item.currency).sort()).toEqual(['BRL', 'USD']);
    expect(items.find((item) => item.currency === 'BRL')?.spent).toEqual({ minorUnits: 1500, currency: 'BRL' });
    expect(items.find((item) => item.currency === 'USD')?.spent).toEqual({ minorUnits: 2000, currency: 'USD' });
  });
});
