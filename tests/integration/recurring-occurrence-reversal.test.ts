import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { LightMyRequestResponse } from 'fastify';
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
  describe('excluding a paid current occurrence', () => {
    const exclusionAuth = { authorization: 'Bearer reversal-user' };

    async function scheduleDaily(accountId: string, startDate: string): Promise<string> {
      const recurring = await prisma.recurringTransaction.create({
        data: {
          householdId,
          accountId,
          categoryName: 'FOOD',
          amount: new Prisma.Decimal('7.25'),
          frequency: 'DAILY',
          startDate: new Date(`${startDate}T00:00:00.000Z`),
          nextRunAt: new Date(`${startDate}T00:00:00.000Z`),
        },
      });
      return recurring.id;
    }

    async function payOccurrence(recurringId: string, date: string, clientMutationId: string): Promise<{ transactionId: string }> {
      const response = await app.inject({
        method: 'POST',
        url: `/v1/recurring-transactions/${recurringId}/occurrences/${date}/pay`,
        headers: exclusionAuth,
        payload: { householdId, amount: { minorUnits: 725, currency: 'BRL' }, clientMutationId },
      });
      expect(response.statusCode).toBe(200);
      return { transactionId: response.json().transactionId as string };
    }

    async function excludeOccurrence(recurringId: string, date: string, scope: string): Promise<LightMyRequestResponse> {
      return app.inject({
        method: 'POST',
        url: `/v1/recurring-transactions/${recurringId}/occurrences/${date}/exclude`,
        headers: exclusionAuth,
        payload: { householdId, scope },
      });
    }

    it('reverses the paid current occurrence, restores the bank balance and removes only that occurrence', async () => {
      const date = todayUtc();
      const accountId = await createBankAccount('Exclude paid ledger account', '100.00');
      const recurringId = await scheduleDaily(accountId, date);
      const paid = await payOccurrence(recurringId, date, '0a1b2c3d-4e5f-4061-8273-849a0b1c2d31');
      expect(await balanceOf(accountId)).toBe('92.75');

      const excluded = await excludeOccurrence(recurringId, date, 'CURRENT_ONLY');
      expect(excluded.statusCode).toBe(200);
      expect(excluded.json()).toMatchObject({
        date,
        scope: 'CURRENT_ONLY',
        replayed: false,
        reversedPayment: { transactionId: paid.transactionId, accountId, amount: { minorUnits: 725, currency: 'BRL' }, balanceRestored: true },
      });
      expect(await balanceOf(accountId)).toBe('100.00');

      const reversed = await prisma.transaction.findFirstOrThrow({ where: { recurringTransactionId: recurringId } });
      expect(reversed.deletedAt).not.toBeNull();
      expect(reversed.paid).toBe(true);

      const repay = await app.inject({
        method: 'POST',
        url: `/v1/recurring-transactions/${recurringId}/occurrences/${date}/pay`,
        headers: exclusionAuth,
        payload: { householdId, amount: { minorUnits: 725, currency: 'BRL' }, clientMutationId: '1b2c3d4e-5f60-4172-8394-a5b6c7d8e9f0' },
      });
      expect(repay.statusCode).toBe(409);
      expect(repay.json().error.code).toBe('RECURRING_OCCURRENCE_EXCLUDED');
      expect(await balanceOf(accountId)).toBe('100.00');
    });

    it('leaves the series and other paid occurrences untouched', async () => {
      const today = todayUtc();
      const now = new Date();
      const tomorrow = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)).toISOString().slice(0, 10);
      const accountId = await createBankAccount('Exclude series ledger account', '100.00');
      const recurringId = await scheduleDaily(accountId, today);
      await payOccurrence(recurringId, today, '2c3d4e5f-6071-4283-9405-b6c7d8e9f0a1');
      const tomorrowPayment = await payOccurrence(recurringId, tomorrow, '3d4e5f60-7182-4394-8516-c7d8e9f0a1b2');
      expect(await balanceOf(accountId)).toBe('85.50');
      const before = await prisma.recurringTransaction.findUniqueOrThrow({ where: { id: recurringId } });

      const excluded = await excludeOccurrence(recurringId, today, 'CURRENT_ONLY');
      expect(excluded.statusCode).toBe(200);
      expect(await balanceOf(accountId)).toBe('92.75');

      const after = await prisma.recurringTransaction.findUniqueOrThrow({ where: { id: recurringId } });
      expect(after).toMatchObject({ isActive: before.isActive, cancelledAt: before.cancelledAt, nextRunAt: before.nextRunAt });
      expect(await prisma.transaction.findUniqueOrThrow({ where: { id: tomorrowPayment.transactionId } })).toMatchObject({ paid: true, deletedAt: null });
    });

    it('does not reverse twice on a repeated exclusion, sequential or concurrent', async () => {
      const date = todayUtc();
      const accountId = await createBankAccount('Exclude repeat ledger account', '100.00');
      const recurringId = await scheduleDaily(accountId, date);
      await payOccurrence(recurringId, date, '4e5f6071-8293-4a05-8627-d8e9f0a1b2c3');

      const [first, second] = await Promise.all([
        excludeOccurrence(recurringId, date, 'CURRENT_ONLY'),
        excludeOccurrence(recurringId, date, 'CURRENT_ONLY'),
      ]);
      expect(first.statusCode).toBe(200);
      expect(second.statusCode).toBe(200);
      expect([first.json().replayed, second.json().replayed].sort()).toEqual([false, true]);
      expect(await balanceOf(accountId)).toBe('100.00');

      const third = await excludeOccurrence(recurringId, date, 'CURRENT_ONLY');
      expect(third.statusCode).toBe(200);
      expect(third.json()).toMatchObject({ replayed: true, reversedPayment: { amount: { minorUnits: 725, currency: 'BRL' }, balanceRestored: true } });
      expect(first.json().reversedPayment).toEqual(third.json().reversedPayment);
      expect(await balanceOf(accountId)).toBe('100.00');
      expect(await prisma.transaction.count({ where: { recurringTransactionId: recurringId, deletedAt: null } })).toBe(0);
    });

    it('keeps refusing a wider scope while the current occurrence is paid, with no balance change', async () => {
      const date = todayUtc();
      const accountId = await createBankAccount('Exclude wider scope ledger account', '100.00');
      const recurringId = await scheduleDaily(accountId, date);
      await payOccurrence(recurringId, date, '5f607182-9304-4b16-8738-e9f0a1b2c3d4');

      const rejected = await excludeOccurrence(recurringId, date, 'CURRENT_AND_FUTURE');
      expect(rejected.statusCode).toBe(409);
      expect(rejected.json().error.code).toBe('RECURRING_OCCURRENCE_PAID');
      expect(await balanceOf(accountId)).toBe('92.75');
    });
    it('restores card debt and invoice total when the paid card occurrence is excluded, and refuses a PAID invoice', async () => {
      const date = todayUtc();
      const card = await prisma.account.create({ data: {
        householdId, name: 'Exclude card', type: 'CREDIT', currency: 'BRL',
        creditLimit: new Prisma.Decimal('500.00'), totalLimit: new Prisma.Decimal('500.00'), availableLimit: new Prisma.Decimal('500.00'),
        closingDay: 14, dueDay: 20,
      } });
      const recurringId = await scheduleDaily(card.id, date);
      const paid = await payOccurrence(recurringId, date, '6071829a-b3c4-4d5e-8f60-a1b2c3d4e5f6');
      const row = await prisma.transaction.findUniqueOrThrow({ where: { id: paid.transactionId } });
      expect(row.invoiceId).not.toBeNull();
      expect((await prisma.creditCardInvoice.findUniqueOrThrow({ where: { id: row.invoiceId! } })).totalAmount.toFixed(2)).toBe('7.25');

      const excluded = await excludeOccurrence(recurringId, date, 'CURRENT_ONLY');
      expect(excluded.statusCode).toBe(200);
      expect(excluded.json().reversedPayment).toMatchObject({ accountId: card.id, amount: { minorUnits: 725, currency: 'BRL' } });
      expect((await prisma.creditCardInvoice.findUniqueOrThrow({ where: { id: row.invoiceId! } })).totalAmount.toFixed(2)).toBe('0.00');
      expect(await balanceOf(card.id)).toBe('0.00');

      const blockedSchedule = await scheduleDaily(card.id, date);
      const blockedPayment = await payOccurrence(blockedSchedule, date, '7182934b-c4d5-4e6f-9071-b2c3d4e5f607');
      const blockedRow = await prisma.transaction.findUniqueOrThrow({ where: { id: blockedPayment.transactionId } });
      await prisma.creditCardInvoice.update({ where: { id: blockedRow.invoiceId! }, data: { status: 'PAID', paidAt: new Date() } });
      const balanceBefore = await balanceOf(card.id);
      const blocked = await excludeOccurrence(blockedSchedule, date, 'CURRENT_ONLY');
      expect(blocked.statusCode).toBe(400);
      expect(blocked.json().error.code).toBe('INVOICE_PAID');
      expect(await balanceOf(card.id)).toBe(balanceBefore);
      expect((await prisma.transaction.findUniqueOrThrow({ where: { id: blockedRow.id } })).deletedAt).toBeNull();
    });
  });
});
