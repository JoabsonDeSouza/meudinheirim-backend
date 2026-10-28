import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { disposeBootstrapTestDb, getBootstrapTestDb } from '../helpers/db-context.js';

let app: FastifyInstance;
let householdId: string;
let cardAccountId: string;
let bankAccountId: string;

async function createPlanTestCard(name: string): Promise<string> {
  const { prisma } = await import('../../src/shared/db/prisma.js');
  const account = await prisma.account.create({
    data: {
      householdId,
      name,
      type: 'CREDIT',
      currency: 'BRL',
      creditLimit: '5000.00',
      totalLimit: '5000.00',
      availableLimit: '5000.00',
      closingDay: 10,
      dueDay: 20,
    },
  });
  return account.id;
}

beforeAll(async () => {
  await getBootstrapTestDb();
  const { setTokenVerifier } = await import('../../src/shared/auth/token-verifier.js');
  const { bootstrapAuthenticatedUser } = await import('../../src/shared/auth/bootstrap.js');
  const { createTestApp } = await import('../helpers/app.js');
  const { prisma } = await import('../../src/shared/db/prisma.js');

  setTokenVerifier({
    verify: async (token: string) => ({ uid: token, email: `${token}@example.com`, emailVerified: true }),
  });
  const user = await bootstrapAuthenticatedUser('transaction-plan-owner', 'transaction-plan@example.com');
  householdId = user.householdId;
  const card = await prisma.account.create({
    data: {
      householdId,
      name: 'Plan card',
      type: 'CREDIT',
      currency: 'BRL',
      creditLimit: '5000.00',
      totalLimit: '5000.00',
      availableLimit: '5000.00',
      closingDay: 10,
      dueDay: 20,
    },
  });
  const bank = await prisma.account.create({
    data: {
      householdId,
      name: 'Plan checking',
      type: 'CHECKING',
      currency: 'BRL',
      balance: '1000.00',
      totalBalance: '1000.00',
      availableBalance: '1000.00',
    },
  });
  cardAccountId = card.id;
  bankAccountId = bank.id;
  app = await createTestApp();
});

afterAll(async () => {
  await app.close();
  await disposeBootstrapTestDb();
});

function payload(clientMutationId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    householdId,
    clientMutationId,
    kind: 'expense',
    totalAmount: { minorUnits: 10001, currency: 'BRL' },
    categoryCode: 'FOOD',
    accountId: cardAccountId,
    occurredAt: '2026-01-31T12:00:00.000Z',
    timeZone: 'America/Sao_Paulo',
    paid: false,
    plan: { type: 'INSTALLMENTS', count: 4 },
    ...overrides,
  };
}

function localDate(instant: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(new Date(instant));
  const value = (type: string): string => parts.find((part) => part.type === type)?.value ?? '';
  return `${value('year')}-${value('month')}-${value('day')}`;
}

describe('V1 transaction plans', () => {
  it('creates all 24 monthly installments and conserves the total minor units', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/transactions/plans',
      headers: { authorization: 'Bearer transaction-plan-owner' },
      payload: payload('d3456789-abcd-4ef0-8123-456789abcdef', {
        accountId: await createPlanTestCard('24-installment plan card'),
        totalAmount: { minorUnits: 2401, currency: 'BRL' },
        occurredAt: '2026-01-31T12:00:00.000Z',
        plan: { type: 'INSTALLMENTS', count: 24 },
      }),
    });

    expect(response.statusCode, JSON.stringify(response.json())).toBe(201);
    const body = response.json() as {
      installmentCount: number;
      totalAmount: { minorUnits: number };
      items: Array<{ amount: { minorUnits: number }; installmentNumber: number; totalInstallments: number }>;
    };
    expect(body.installmentCount).toBe(24);
    expect(body.totalAmount.minorUnits).toBe(2401);
    expect(body.items).toHaveLength(24);
    expect(body.items.map((item) => item.installmentNumber)).toEqual(Array.from({ length: 24 }, (_, index) => index + 1));
    expect(body.items.every((item) => item.totalInstallments === 24)).toBe(true);
    expect(body.items.map((item) => item.amount.minorUnits)).toEqual([101, ...Array<number>(23).fill(100)]);
    expect(body.items.reduce((sum, item) => sum + item.amount.minorUnits, 0)).toBe(2401);
  });

  it('creates 4 monthly card installments, conserves total cents, and assigns each billing cycle', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/transactions/plans',
      headers: { authorization: 'Bearer transaction-plan-owner' },
      payload: payload('a0123456-789b-4cde-8f01-23456789abcd', {
        occurredAt: '2026-01-31T00:00:00+09:00',
        timeZone: 'Asia/Tokyo',
      }),
    });
    expect(response.statusCode, JSON.stringify(response.json())).toBe(201);
    const body = response.json() as {
      type: string;
      totalAmount: { minorUnits: number; currency: string };
      items: Array<{ id: string; amount: { minorUnits: number }; occurredAt: string; installmentNumber: number; totalInstallments: number; installmentId: string; invoiceId: string | null; paid: boolean }>;
    };
    expect(body.type).toBe('INSTALLMENTS');
    expect(body.totalAmount).toEqual({ minorUnits: 10001, currency: 'BRL' });
    expect(body.items.map((item) => item.amount.minorUnits)).toEqual([2501, 2500, 2500, 2500]);
    expect(body.items.reduce((sum, item) => sum + item.amount.minorUnits, 0)).toBe(10001);
    expect(body.items.map((item) => localDate(item.occurredAt, 'Asia/Tokyo'))).toEqual(['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30']);
    expect(body.items.map((item) => item.installmentNumber)).toEqual([1, 2, 3, 4]);
    expect(body.items.every((item) => item.totalInstallments === 4 && item.installmentId === body.items[0].installmentId)).toBe(true);
    expect(body.items.every((item) => item.invoiceId !== null)).toBe(true);
    expect(new Set(body.items.map((item) => item.invoiceId)).size).toBe(4);
    expect(body.items.every((item) => !item.paid)).toBe(true);

    const { prisma } = await import('../../src/shared/db/prisma.js');
    expect(await prisma.invoicePayment.count({ where: { invoiceId: { in: body.items.map((item) => item.invoiceId!) } } })).toBe(0);
    const persisted = await prisma.transaction.findMany({ where: { installmentId: body.items[0].installmentId }, orderBy: { installmentNumber: 'asc' } });
    expect(persisted).toHaveLength(4);
    expect(persisted.map((item) => [item.installmentNumber, item.totalInstallments])).toEqual([[1, 4], [2, 4], [3, 4], [4, 4]]);
  });

  it('replays concurrent duplicate requests without creating duplicate transactions', async () => {
    const request = payload('b1234567-89ab-4cde-8f01-23456789abcd', {
      accountId: await createPlanTestCard('Concurrent plan card'),
      occurredAt: '2027-01-31T12:00:00.000Z',
      plan: { type: 'INSTALLMENTS', count: 2 },
    });
    const [first, second] = await Promise.all([
      app.inject({ method: 'POST', url: '/v1/transactions/plans', headers: { authorization: 'Bearer transaction-plan-owner' }, payload: request }),
      app.inject({ method: 'POST', url: '/v1/transactions/plans', headers: { authorization: 'Bearer transaction-plan-owner' }, payload: request }),
    ]);
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(second.json()).toEqual(first.json());
    const body = first.json() as { installmentId: string; items: Array<{ id: string }> };
    const { prisma } = await import('../../src/shared/db/prisma.js');
    expect(await prisma.transaction.count({ where: { installmentId: body.installmentId } })).toBe(2);
  });

  it('creates the first continuous occurrence and advances the next monthly run without duplicating it', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/transactions/plans',
      headers: { authorization: 'Bearer transaction-plan-owner' },
      payload: payload('c2345678-9abc-4def-8012-3456789abcde', {
        accountId: bankAccountId,
        paid: false,
        plan: { type: 'RECURRING_MONTHLY' },
      }),
    });
    expect(response.statusCode).toBe(201);
    const body = response.json() as {
      type: string;
      recurringTransaction: { id: string; startDate: string; nextRunAt: string; lastRunDate: string | null; anchorDay: number; recurrenceMode: string };
      firstOccurrence: { id: string; occurredAt: string; paid: boolean };
    };
    expect(body.type).toBe('RECURRING_MONTHLY');
    expect(body.recurringTransaction).toMatchObject({ startDate: '2026-01-31', nextRunAt: '2026-02-28', lastRunDate: '2026-01-31', anchorDay: 31, recurrenceMode: 'ALWAYS' });
    expect(body.firstOccurrence).toMatchObject({ occurredAt: '2026-01-31T12:00:00.000Z', paid: false });

    const { prisma } = await import('../../src/shared/db/prisma.js');
    expect(await prisma.recurringOccurrence.count({ where: { recurringTransactionId: body.recurringTransaction.id } })).toBe(1);
    expect(await prisma.transaction.count({ where: { recurringTransactionId: body.recurringTransaction.id } })).toBe(1);
    const occurrences = await app.inject({
      method: 'GET',
      url: `/v1/recurring-transactions/occurrences?householdId=${householdId}&from=2026-01-31&to=2026-03-31`,
      headers: { authorization: 'Bearer transaction-plan-owner' },
    });
    expect(occurrences.statusCode).toBe(200);
    expect(occurrences.json().items.map((item: { date: string }) => item.date)).toEqual(['2026-01-31', '2026-02-28', '2026-03-31']);
  });

  it('creates monthly income recurrence with an income first occurrence', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/transactions/plans',
      headers: { authorization: 'Bearer transaction-plan-owner' },
      payload: payload('12345678-9abc-4def-8123-456789abcdef', {
        accountId: bankAccountId,
        categoryCode: 'SALARY',
        kind: 'income',
        occurredAt: '2026-01-31T00:00:00+09:00',
        timeZone: 'Asia/Tokyo',
        plan: { type: 'RECURRING_MONTHLY' },
      }),
    });
    expect(response.statusCode, JSON.stringify(response.json())).toBe(201);
    const body = response.json() as {
      recurringTransaction: { id: string; categoryCode: string; frequency: string; recurrenceMode: string };
      firstOccurrence: { id: string; kind: string; categoryCode: string; occurredAt: string };
    };
    expect(body.recurringTransaction).toMatchObject({ categoryCode: 'SALARY', frequency: 'MONTHLY', recurrenceMode: 'ALWAYS', startDate: '2026-01-31' });
    expect(body.firstOccurrence).toMatchObject({ kind: 'income', categoryCode: 'SALARY', occurredAt: '2026-01-30T15:00:00.000Z' });
    const { prisma } = await import('../../src/shared/db/prisma.js');
    const persisted = await prisma.transaction.findUnique({ where: { id: body.firstOccurrence.id } });
    expect(persisted?.type).toBe('INCOME');
    expect(persisted?.recurringTransactionId).toBe(body.recurringTransaction.id);
    expect(await prisma.recurringOccurrence.count({
      where: { recurringTransactionId: body.recurringTransaction.id, occurrenceDate: new Date('2026-01-31T00:00:00.000Z') },
    })).toBe(1);
  });

  it('rejects installments on bank accounts and requires authentication', async () => {
    const unauthorized = await app.inject({ method: 'POST', url: '/v1/transactions/plans', payload: payload('d3456789-abcd-4ef0-9123-456789abcdef') });
    expect(unauthorized.statusCode).toBe(401);
    const invalidAccount = await app.inject({
      method: 'POST',
      url: '/v1/transactions/plans',
      headers: { authorization: 'Bearer transaction-plan-owner' },
      payload: payload('e456789a-bcde-4f01-a234-56789abcdef0', { accountId: bankAccountId }),
    });
    expect(invalidAccount.statusCode).toBe(400);
    expect(invalidAccount.json().error.code).toBe('BAD_REQUEST');

    const { bootstrapAuthenticatedUser } = await import('../../src/shared/auth/bootstrap.js');
    await bootstrapAuthenticatedUser('transaction-plan-outsider', 'transaction-plan-outsider@example.com');
    const nonMember = await app.inject({
      method: 'POST',
      url: '/v1/transactions/plans',
      headers: { authorization: 'Bearer transaction-plan-outsider' },
      payload: payload('01234567-89ab-4cde-8012-3456789abcde'),
    });
    expect(nonMember.statusCode).toBe(403);
    expect(['FORBIDDEN', 'INSUFFICIENT_ROLE']).toContain(nonMember.json().error.code);
  });

  it('rolls back earlier installments when a later invoice cycle is closed', async () => {
    const { prisma } = await import('../../src/shared/db/prisma.js');
    const rollbackCardAccountId = await createPlanTestCard('Rollback plan card');
    const preexistingInvoice = await prisma.creditCardInvoice.create({
      data: {
        householdId,
        cardAccountId: rollbackCardAccountId,
        periodStart: new Date('2027-02-10T00:00:00.000Z'),
        periodEnd: new Date('2027-03-10T00:00:00.000Z'),
        dueDate: new Date('2027-03-20T00:00:00.000Z'),
        status: 'CLOSED',
        currency: 'BRL',
        totalAmount: '0.00',
      },
    });
    const failed = await app.inject({
      method: 'POST',
      url: '/v1/transactions/plans',
      headers: { authorization: 'Bearer transaction-plan-owner' },
      payload: payload('f56789ab-cdef-4012-b345-6789abcdef01', {
        accountId: rollbackCardAccountId,
        occurredAt: '2027-01-31T12:00:00.000Z',
        plan: { type: 'INSTALLMENTS', count: 2 },
      }),
    });
    expect(failed.statusCode).toBe(400);
    expect(failed.json().error.code).toBe('BAD_REQUEST');
    expect(await prisma.transaction.count({ where: { clientMutationId: 'f56789ab-cdef-4012-b345-6789abcdef01' } })).toBe(0);
    expect(await prisma.creditCardInvoice.count({ where: { cardAccountId: rollbackCardAccountId, periodStart: new Date('2027-01-10T00:00:00.000Z') } })).toBe(0);
    expect(await prisma.creditCardInvoice.findUnique({ where: { id: preexistingInvoice.id } })).not.toBeNull();
  });
});
