import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Prisma, type PrismaClient } from '../../src/generated/prisma/client.js';

import { disposeBootstrapTestDb, getBootstrapTestDb } from '../helpers/db-context.js';

let app: FastifyInstance;
let prisma: PrismaClient;
let householdId: string;
const auth = { authorization: 'Bearer reversal-user' };

beforeAll(async () => {
  await getBootstrapTestDb();
  const { bootstrapAuthenticatedUser } = await import('../../src/shared/auth/bootstrap.js');
  const db = await import('../../src/shared/db/prisma.js');
  const { setTokenVerifier } = await import('../../src/shared/auth/token-verifier.js');
  const { createTestApp } = await import('../helpers/app.js');
  prisma = db.prisma;
  setTokenVerifier({
    verify: async (token: string) => ({ uid: token, email: 'reversal@example.com', emailVerified: true }),
  });
  const user = await bootstrapAuthenticatedUser('reversal-user', 'reversal@example.com');
  householdId = user.householdId;
  app = await createTestApp();
});

afterAll(async () => {
  await app.close();
  await disposeBootstrapTestDb();
});

async function createBankAccount(name: string, balance: string): Promise<string> {
  const account = await prisma.account.create({
    data: {
      householdId,
      name,
      type: 'CHECKING',
      currency: 'BRL',
      balance: new Prisma.Decimal(balance),
      availableBalance: new Prisma.Decimal(balance),
      totalBalance: new Prisma.Decimal(balance),
      allocatedBalance: new Prisma.Decimal('0.00'),
    },
  });
  return account.id;
}

async function balanceOf(accountId: string): Promise<string> {
  return (await prisma.account.findUniqueOrThrow({ where: { id: accountId } })).balance.toFixed(2);
}

function todayUtc(): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString().slice(0, 10);
}

describe('recurring occurrence payment and reversal', () => {
  it('debits the bank account on payment and pays again after the paid transaction was reversed', async () => {
    const date = todayUtc();
    const accountId = await createBankAccount('Reversal ledger account', '100.00');
    const recurring = await prisma.recurringTransaction.create({
      data: {
        householdId,
        accountId,
        categoryName: 'FOOD',
        amount: new Prisma.Decimal('7.25'),
        frequency: 'DAILY',
        startDate: new Date(`${date}T00:00:00.000Z`),
        nextRunAt: new Date(`${date}T00:00:00.000Z`),
      },
    });
    const payUrl = `/v1/recurring-transactions/${recurring.id}/occurrences/${date}/pay`;
    const amount = { minorUnits: 725, currency: 'BRL' };

    const firstPayment = await app.inject({
      method: 'POST',
      url: payUrl,
      headers: auth,
      payload: { householdId, amount, clientMutationId: '6f1d2c3b-4a5e-4f60-8b71-92a3b4c5d6e1' },
    });
    expect(firstPayment.statusCode).toBe(200);
    expect(firstPayment.json()).toMatchObject({ status: 'PAID', replayed: false });
    expect(await balanceOf(accountId)).toBe('92.75');

    const firstTransactionId = firstPayment.json().transactionId as string;
    const firstTransaction = await prisma.transaction.findUniqueOrThrow({ where: { id: firstTransactionId } });
    const reversal = await app.inject({
      method: 'DELETE',
      url: `/v1/transactions/${firstTransactionId}?householdId=${householdId}&clientMutationId=7a2e3d4c-5b6f-4071-9c82-a3b4c5d6e7f2&expectedVersion=${firstTransaction.version}`,
      headers: auth,
    });
    expect(reversal.statusCode).toBe(200);
    expect(await balanceOf(accountId)).toBe('100.00');

    const secondPayment = await app.inject({
      method: 'POST',
      url: payUrl,
      headers: auth,
      payload: { householdId, amount, clientMutationId: '8b3f4e5d-6c7a-4182-8d93-b4c5d6e7f803' },
    });
    expect(secondPayment.statusCode).toBe(200);
    expect(secondPayment.json()).toMatchObject({ status: 'PAID', replayed: false });
    expect(secondPayment.json().transactionId).not.toBe(firstTransactionId);
    expect(await balanceOf(accountId)).toBe('92.75');
    expect(await prisma.transaction.count({ where: { recurringTransactionId: recurring.id, paid: true, deletedAt: null } })).toBe(1);
  });
});
