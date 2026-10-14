import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Prisma, type PrismaClient } from '../../src/generated/prisma/client.js';

import { disposeBootstrapTestDb, getBootstrapTestDb } from '../helpers/db-context.js';

let app: FastifyInstance;
let prisma: PrismaClient;
let householdId: string;
let accountId: string;

beforeAll(async () => {
  await getBootstrapTestDb();
  const { bootstrapAuthenticatedUser } = await import('../../src/shared/auth/bootstrap.js');
  const db = await import('../../src/shared/db/prisma.js');
  const { setTokenVerifier } = await import('../../src/shared/auth/token-verifier.js');
  const { createTestApp } = await import('../helpers/app.js');
  prisma = db.prisma;
  setTokenVerifier({
    verify: async (token: string) => ({ uid: token, email: 'recurring@example.com', emailVerified: true }),
  });
  const user = await bootstrapAuthenticatedUser('recurring-user', 'recurring@example.com');
  householdId = user.householdId;
  const account = await prisma.account.create({
    data: {
      householdId,
      name: 'Recurring account',
      type: 'CHECKING',
      currency: 'BRL',
      balance: new Prisma.Decimal('100.00'),
      availableBalance: new Prisma.Decimal('100.00'),
      totalBalance: new Prisma.Decimal('100.00'),
      allocatedBalance: new Prisma.Decimal('0.00'),
    },
  });
  accountId = account.id;
  app = await createTestApp();
});

afterAll(async () => {
  await app.close();
  await disposeBootstrapTestDb();
});

describe('recurring occurrence idempotency', () => {
  it('creates a V1 schedule using MoneyDto and explicit IANA timezone', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/recurring-transactions',
      headers: { authorization: 'Bearer recurring-user' },
      payload: {
        householdId,
        accountId,
        categoryCode: 'FOOD',
        amount: { minorUnits: 1234, currency: 'BRL' },
        frequency: 'MONTHLY',
        startDate: '2026-10-13',
        nextRunAt: '2026-10-13',
        timeZone: 'America/Sao_Paulo',
      },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      amount: { minorUnits: 1234, currency: 'BRL' },
      timeZone: 'America/Sao_Paulo',
    });
  });

  it('re-running the same occurrence returns the original transaction and creates no duplicate', async () => {
    const occurrenceDate = new Date('2026-10-13T00:00:00.000Z');
    const recurring = await prisma.recurringTransaction.create({
      data: {
        householdId,
        accountId,
        categoryName: 'FOOD',
        amount: new Prisma.Decimal('12.34'),
        frequency: 'MONTHLY',
        startDate: occurrenceDate,
        nextRunAt: occurrenceDate,
      },
    });

    const { executeRecurringTransaction } = await import('../../src/modules/recurring-transactions/recurring-transactions.service.js');
    const first = await executeRecurringTransaction(recurring.id, householdId, { date: occurrenceDate, paid: true });
    const retry = await executeRecurringTransaction(recurring.id, householdId, { date: occurrenceDate, paid: true });

    expect(retry.transaction.id).toBe(first.transaction.id);
    expect(await prisma.transaction.count({ where: { recurringTransactionId: recurring.id, date: occurrenceDate } })).toBe(1);
    const updatedAccount = await prisma.account.findUniqueOrThrow({ where: { id: accountId } });
    expect(updatedAccount.availableBalance.toFixed(2)).toBe('87.66');
  });
});
