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

  it('expands N occurrences, records a variable actual amount once, and separates paid totals', async () => {
    const start = new Date();
    start.setUTCDate(start.getUTCDate() - 1);
    const startDate = start.toISOString().slice(0, 10);
    const response = await app.inject({
      method: 'POST',
      url: '/v1/recurring-transactions/managed',
      headers: { authorization: 'Bearer recurring-user' },
      payload: {
        householdId,
        accountId,
        categoryCode: 'FOOD',
        amount: { minorUnits: 1234, currency: 'BRL' },
        frequency: 'MONTHLY',
        kind: 'VARIABLE',
        recurrenceMode: 'LIMITED',
        occurrencesLimit: 3,
        startDate,
        timeZone: 'America/Sao_Paulo',
      },
    });
    expect(response.statusCode).toBe(201);
    const recurringId = response.json().id as string;
    const before = await prisma.account.findUniqueOrThrow({ where: { id: accountId } });
    const mutationId = '6b694574-3846-4ba6-9c76-a3b09834683d';
    const payment = await app.inject({
      method: 'POST',
      url: `/v1/recurring-transactions/${recurringId}/occurrences/${startDate}/pay`,
      headers: { authorization: 'Bearer recurring-user' },
      payload: { householdId, amount: { minorUnits: 2000, currency: 'BRL' }, clientMutationId: mutationId },
    });
    expect(payment.statusCode).toBe(200);
    expect(payment.json()).toMatchObject({ status: 'PAID', amount: { minorUnits: 2000, currency: 'BRL' }, replayed: false });
    const balance = await prisma.account.findUniqueOrThrow({ where: { id: accountId } });
    expect(balance.availableBalance.toFixed(2)).toBe(before.availableBalance.sub(20).toFixed(2));

    const retry = await app.inject({
      method: 'POST',
      url: `/v1/recurring-transactions/${recurringId}/occurrences/${startDate}/pay`,
      headers: { authorization: 'Bearer recurring-user' },
      payload: { householdId, amount: { minorUnits: 2000, currency: 'BRL' }, clientMutationId: '4fbc37b6-381f-4cc6-a81a-b5462bf21d89' },
    });
    expect(retry.statusCode).toBe(200);
    expect(retry.json().replayed).toBe(true);
    const afterRetry = await prisma.account.findUniqueOrThrow({ where: { id: accountId } });
    expect(afterRetry.availableBalance.toFixed(2)).toBe(balance.availableBalance.toFixed(2));

    const edit = await app.inject({
      method: 'PATCH',
      url: `/v1/recurring-transactions/${recurringId}?householdId=${householdId}`,
      headers: { authorization: 'Bearer recurring-user' },
      payload: { amount: { minorUnits: 1500, currency: 'BRL' }, description: 'Updated estimate' },
    });
    expect(edit.statusCode).toBe(200);
    expect(edit.json()).toMatchObject({ amount: { minorUnits: 1500, currency: 'BRL' }, description: 'Updated estimate' });

    const from = startDate;
    const toDate = new Date(start);
    toDate.setUTCMonth(toDate.getUTCMonth() + 2);
    const expanded = await app.inject({
      method: 'GET',
      url: `/v1/recurring-transactions/occurrences?householdId=${householdId}&from=${from}&to=${toDate.toISOString().slice(0, 10)}`,
      headers: { authorization: 'Bearer recurring-user' },
    });
    expect(expanded.statusCode).toBe(200);
    const occurrenceRows = (expanded.json().items as Array<{
      recurringTransactionId: string; status: string; amount: { minorUnits: number; currency: string }; isEstimate: boolean;
    }>).filter((item) => item.recurringTransactionId === recurringId);
    expect(occurrenceRows).toHaveLength(3);
    expect(occurrenceRows[0]).toMatchObject({ status: 'PAID', amount: { minorUnits: 2000, currency: 'BRL' }, isEstimate: false });
    expect(occurrenceRows[1]).toMatchObject({ status: 'SCHEDULED', amount: { minorUnits: 1500, currency: 'BRL' }, isEstimate: true });
    const brlTotals = expanded.json().totalsByCurrency.find((item: { currency: string }) => item.currency === 'BRL');
    expect(brlTotals).toMatchObject({
      currency: 'BRL', totalMinorUnits: expect.any(Number), paidMinorUnits: expect.any(Number), remainingMinorUnits: expect.any(Number),
    });
    expect(brlTotals.totalMinorUnits).toBeGreaterThanOrEqual(5000);

    const cancelled = await app.inject({
      method: 'DELETE',
      url: `/v1/recurring-transactions/${recurringId}?householdId=${householdId}`,
      headers: { authorization: 'Bearer recurring-user' },
    });
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json().isActive).toBe(false);
    expect(await prisma.transaction.count({ where: { recurringTransactionId: recurringId, paid: true, deletedAt: null } })).toBe(1);
  });
});
