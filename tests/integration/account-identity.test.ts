import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '../../src/generated/prisma/client.js';

import { disposeBootstrapTestDb, getBootstrapTestDb } from '../helpers/db-context.js';

let app: FastifyInstance;
let prisma: PrismaClient;
let householdId: string;

beforeAll(async () => {
  await getBootstrapTestDb();
  const { setTokenVerifier } = await import('../../src/shared/auth/token-verifier.js');
   const { bootstrapAuthenticatedUser } = await import('../../src/shared/auth/bootstrap.js');
   const db = await import('../../src/shared/db/prisma.js');
  const { createTestApp } = await import('../helpers/app.js');
  setTokenVerifier({
    verify: async (token: string) => ({
      uid: token,
      email: `${token}@example.com`,
      emailVerified: true,
    }),
  });
   const user = await bootstrapAuthenticatedUser('account-identity-user', 'identity@example.com');
   householdId = user.householdId;
   prisma = db.prisma;
  app = await createTestApp();
});

afterAll(async () => {
  await app.close();
  await disposeBootstrapTestDb();
});

describe('account display identity persistence', () => {
  it('persists optional institution, brand, card network and last4 alongside UUID identity', async () => {
    const create = await app.inject({
      method: 'POST',
      url: '/v1/accounts',
      headers: { authorization: 'Bearer account-identity-user' },
      payload: {
        name: 'Daily Card',
        type: 'CREDIT',
        currency: 'BRL',
        institution: 'Example Bank',
        brand: 'Platinum',
        cardNetwork: 'VISA',
        last4: '0427',
        creditLimit: 3000,
        dueDay: 15,
        closingDay: 8,
      },
    });
    expect(create.statusCode).toBe(201);
    const created = create.json() as {
      success: boolean;
      data: {
        id: string;
        currency: string;
        institution: string | null;
        brand: string | null;
        cardNetwork: string | null;
        last4: string | null;
      };
    };
    expect(created.data.id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(created.data.currency).toBe('BRL');
    expect(created.data.institution).toBe('Example Bank');
    expect(created.data.brand).toBe('Platinum');
    expect(created.data.cardNetwork).toBe('VISA');
    expect(created.data.last4).toBe('0427');
  });

  it('rejects unsupported currency and malformed last4 at the API boundary', async () => {
    const unsupportedCurrency = await app.inject({
      method: 'POST',
      url: '/v1/accounts',
      headers: { authorization: 'Bearer account-identity-user' },
      payload: { name: 'Euro', type: 'CHECKING', currency: 'EUR' },
    });
    expect(unsupportedCurrency.statusCode).toBe(400);

    const invalidLast4 = await app.inject({
      method: 'POST',
      url: '/v1/accounts',
      headers: { authorization: 'Bearer account-identity-user' },
      payload: { name: 'Bad Card', type: 'CREDIT', currency: 'BRL', last4: '4A27' },
    });
    expect(invalidLast4.statusCode).toBe(400);
  });

  it('serializes concurrent primary-card changes and clears the default when that card is archived', async () => {
    const createCard = async (name: string, currency: 'BRL' | 'USD' = 'BRL'): Promise<string> => {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/accounts',
        headers: { authorization: 'Bearer account-identity-user' },
        payload: { name, type: 'CREDIT', currency, balance: 0, creditLimit: 1000, dueDay: 10, closingDay: 3 },
      });
      expect(response.statusCode).toBe(201);
      return (response.json() as { data: { id: string } }).data.id;
    };
    const first = await createCard('Primary candidate one');
    const second = await createCard('Primary candidate two');
    const usd = await createCard('USD primary candidate', 'USD');

    const responses = await Promise.all([first, second].map((accountId) => app.inject({
      method: 'POST',
      url: `/v1/accounts/${accountId}/primary-card`,
      headers: { authorization: 'Bearer account-identity-user' },
    })));
    expect(responses.map((response) => response.statusCode)).toEqual([200, 200]);
    await app.inject({
      method: 'POST', url: `/v1/accounts/${usd}/primary-card`,
      headers: { authorization: 'Bearer account-identity-user' },
    });
    const primaryCards = await prisma.account.findMany({ where: { householdId, isPrimaryCard: true } });
    expect(primaryCards).toHaveLength(2);
    expect(primaryCards.map((account) => account.currency).sort()).toEqual(['BRL', 'USD']);
    const brlPrimary = primaryCards.find((account) => account.currency === 'BRL');
    expect(brlPrimary).toBeDefined();

    const archived = await app.inject({
      method: 'POST', url: `/v1/accounts/${brlPrimary!.id}/archive`,
      headers: { authorization: 'Bearer account-identity-user' },
    });
    expect(archived.statusCode).toBe(200);
    expect(archived.json()).toMatchObject({ data: { isActive: false, status: 'INACTIVE', isPrimaryCard: false } });
    expect(await prisma.account.count({ where: { householdId, currency: 'BRL', isPrimaryCard: true } })).toBe(0);
  });

  it('blocks unsafe archive, then archives without deleting settled transaction history', async () => {
    const account = await prisma.account.create({
      data: { householdId, name: 'Archive candidate', type: 'CHECKING', currency: 'BRL' },
    });
    const recurring = await prisma.recurringTransaction.create({
      data: {
        householdId,
        accountId: account.id,
        categoryName: 'FOOD',
        amount: '10.00',
        frequency: 'MONTHLY',
        startDate: new Date('2026-11-01T00:00:00.000Z'),
        nextRunAt: new Date('2026-11-01T00:00:00.000Z'),
      },
    });
    const blocked = await app.inject({
      method: 'POST', url: `/v1/accounts/${account.id}/archive`,
      headers: { authorization: 'Bearer account-identity-user' },
    });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json()).toMatchObject({ success: false, error: { code: 'ACCOUNT_ARCHIVE_BLOCKED' } });

    await prisma.recurringTransaction.update({ where: { id: recurring.id }, data: { isActive: false } });
    const transaction = await prisma.transaction.create({
      data: {
        householdId,
        accountId: account.id,
        type: 'EXPENSE',
        categoryName: 'FOOD',
        amount: '10.00',
        date: new Date('2026-10-01T00:00:00.000Z'),
        occurredAt: new Date('2026-10-01T00:00:00.000Z'),
        paid: true,
      },
    });
    const archived = await app.inject({
      method: 'POST', url: `/v1/accounts/${account.id}/archive`,
      headers: { authorization: 'Bearer account-identity-user' },
    });
    expect(archived.statusCode).toBe(200);
    expect(await prisma.transaction.findUnique({ where: { id: transaction.id } })).toMatchObject({ accountId: account.id });
    expect(await prisma.account.findUnique({ where: { id: account.id } })).toMatchObject({ isActive: false, status: 'INACTIVE' });
  });

  it('does not allow card edits to set the card balance outside invoice settlement', async () => {
    const card = await prisma.account.create({
      data: {
        householdId, name: 'Balance-protected card', type: 'CREDIT', currency: 'BRL',
        balance: 0, totalBalance: 0, availableBalance: 0, creditLimit: 500,
        totalLimit: 500, availableLimit: 500, dueDay: 10, closingDay: 3,
      },
    });
    const response = await app.inject({
      method: 'PATCH',
      url: `/v1/accounts/${card.id}`,
      headers: { authorization: 'Bearer account-identity-user' },
      payload: { balance: 123.45 },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ success: false, error: { code: 'BAD_REQUEST' } });
    expect((await prisma.account.findUniqueOrThrow({ where: { id: card.id } })).balance.toFixed(2)).toBe('0.00');
  });
});
