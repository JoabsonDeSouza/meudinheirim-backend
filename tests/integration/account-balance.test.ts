import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '../../src/generated/prisma/client.js';
import { Prisma } from '../../src/generated/prisma/client.js';

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
  const user = await bootstrapAuthenticatedUser('account-balance-user', 'balance@example.com');
  householdId = user.householdId;
  prisma = db.prisma;
  app = await createTestApp();
});

afterAll(async () => {
  await app.close();
  await disposeBootstrapTestDb();
});

describe('account initial balance and traceable balance adjustment', () => {
  async function createBankAccount(name: string, balance: number): Promise<string> {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/accounts',
      headers: { authorization: 'Bearer account-balance-user' },
      payload: {
        name,
        type: 'CHECKING',
        currency: 'BRL',
        balance,
      },
    });
    expect(response.statusCode).toBe(201);
    return (response.json() as { data: { id: string } }).data.id;
  }

  it('creates a bank account with a non-zero initial balance across ledger fields', async () => {
    const id = await createBankAccount('Initial balance account', 250.5);

    const account = await prisma.account.findUniqueOrThrow({ where: { id } });
    expect(account.balance.toFixed(2)).toBe('250.50');
    expect(account.totalBalance.toFixed(2)).toBe('250.50');
    expect(account.availableBalance.toFixed(2)).toBe('250.50');
    expect(account.allocatedBalance.toFixed(2)).toBe('0.00');

    const transactions = await prisma.transaction.count({ where: { accountId: id } });
    expect(transactions).toBe(0);
  });

  it('adjusts balance up through the dedicated endpoint and records an income adjustment', async () => {
    const id = await createBankAccount('Adjust up account', 100);

    const response = await app.inject({
      method: 'POST',
      url: `/v1/accounts/${id}/adjust-balance`,
      headers: { authorization: 'Bearer account-balance-user' },
      payload: { newBalance: 175.25, reason: 'Found cash' },
    });
    expect(response.statusCode).toBe(200);

    const body = response.json() as {
      data: {
        account: { balance: number; totalBalance: number; availableBalance: number };
        adjustment: { categoryName: string; amount: number; paid: boolean } | null;
      };
    };
    expect(body.data.adjustment).not.toBeNull();
    expect(body.data.adjustment?.categoryName).toBe('OTHER_INCOME');
    expect(body.data.adjustment?.amount).toBe('75.25');
    expect(body.data.adjustment?.paid).toBe(true);

    const account = await prisma.account.findUniqueOrThrow({ where: { id } });
    expect(account.totalBalance.toFixed(2)).toBe('175.25');
    expect(account.availableBalance.toFixed(2)).toBe('175.25');
  });

  it('blocks downward adjustment that would make availableBalance negative because of allocations', async () => {
    const id = await createBankAccount('Allocated account', 100);
    await prisma.account.update({
      where: { id },
      data: {
        allocatedBalance: new Prisma.Decimal(30),
        availableBalance: new Prisma.Decimal(70),
      },
    });

    const response = await app.inject({
      method: 'POST',
      url: `/v1/accounts/${id}/adjust-balance`,
      headers: { authorization: 'Bearer account-balance-user' },
      payload: { newBalance: 20 },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ success: false, error: { code: 'BAD_REQUEST' } });

    const account = await prisma.account.findUniqueOrThrow({ where: { id } });
    expect(account.totalBalance.toFixed(2)).toBe('100.00');
    expect(account.availableBalance.toFixed(2)).toBe('70.00');
    expect(account.allocatedBalance.toFixed(2)).toBe('30.00');

    const transactions = await prisma.transaction.count({ where: { accountId: id } });
    expect(transactions).toBe(0);
  });

  it('PATCH balance on a bank account updates ledger fields and creates a traceable adjustment transaction', async () => {
    const id = await createBankAccount('Patch balance account', 100);

    const response = await app.inject({
      method: 'PATCH',
      url: `/v1/accounts/${id}`,
      headers: { authorization: 'Bearer account-balance-user' },
      payload: { balance: 80, name: 'Renamed patch account' },
    });
    expect(response.statusCode).toBe(200);

    const body = response.json() as { data: { name: string; balance: number } };
    expect(body.data.name).toBe('Renamed patch account');
    expect(body.data.balance).toBe(80);

    const account = await prisma.account.findUniqueOrThrow({ where: { id } });
    expect(account.totalBalance.toFixed(2)).toBe('80.00');
    expect(account.availableBalance.toFixed(2)).toBe('80.00');
    expect(account.name).toBe('Renamed patch account');

    const transactions = await prisma.transaction.findMany({ where: { accountId: id } });
    expect(transactions).toHaveLength(1);
    expect(transactions[0].categoryName).toBe('OTHER_EXPENSES');
    expect(transactions[0].amount.toNumber()).toBe(-20);
    expect(transactions[0].paid).toBe(true);
  });

  it('PATCH with the same balance is idempotent and does not create duplicate adjustments', async () => {
    const id = await createBankAccount('Idempotent patch account', 50);

    const first = await app.inject({
      method: 'PATCH',
      url: `/v1/accounts/${id}`,
      headers: { authorization: 'Bearer account-balance-user' },
      payload: { balance: 100 },
    });
    expect(first.statusCode).toBe(200);

    const transactionsBefore = await prisma.transaction.count({ where: { accountId: id } });
    expect(transactionsBefore).toBe(1);

    const second = await app.inject({
      method: 'PATCH',
      url: `/v1/accounts/${id}`,
      headers: { authorization: 'Bearer account-balance-user' },
      payload: { balance: 100 },
    });
    expect(second.statusCode).toBe(200);

    const transactionsAfter = await prisma.transaction.count({ where: { accountId: id } });
    expect(transactionsAfter).toBe(1);

    const account = await prisma.account.findUniqueOrThrow({ where: { id } });
    expect(account.totalBalance.toFixed(2)).toBe('100.00');
    expect(account.availableBalance.toFixed(2)).toBe('100.00');
  });

  it('still rejects PATCH balance on credit cards outside invoice settlement', async () => {
    const card = await prisma.account.create({
      data: {
        householdId,
        name: 'PATCH-protected card',
        type: 'CREDIT',
        currency: 'BRL',
        balance: 0,
        totalBalance: 0,
        availableBalance: 0,
        creditLimit: 500,
        totalLimit: 500,
        availableLimit: 500,
        dueDay: 10,
        closingDay: 3,
      },
    });

    const response = await app.inject({
      method: 'PATCH',
      url: `/v1/accounts/${card.id}`,
      headers: { authorization: 'Bearer account-balance-user' },
      payload: { balance: 123.45 },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ success: false, error: { code: 'BAD_REQUEST' } });
    expect((await prisma.account.findUniqueOrThrow({ where: { id: card.id } })).balance.toFixed(2)).toBe('0.00');
  });
});
