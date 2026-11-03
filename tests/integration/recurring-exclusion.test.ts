import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Response } from 'light-my-request';
import { Prisma, type PrismaClient } from '../../src/generated/prisma/client.js';
import { disposeBootstrapTestDb, getBootstrapTestDb } from '../helpers/db-context.js';

let app: FastifyInstance;
let prisma: PrismaClient;
let householdId: string;
let accountId: string;

beforeAll(async () => {
  await getBootstrapTestDb();
  const { bootstrapAuthenticatedUser } = await import('../../src/shared/auth/bootstrap.js');
  const { setTokenVerifier } = await import('../../src/shared/auth/token-verifier.js');
  const { createTestApp } = await import('../helpers/app.js');
  prisma = (await import('../../src/shared/db/prisma.js')).prisma;
  setTokenVerifier({ verify: async (token: string) => ({ uid: token, email: 'exclusion@example.com', emailVerified: true }) });
  const user = await bootstrapAuthenticatedUser('exclusion-user', 'exclusion@example.com');
  householdId = user.householdId;
  const account = await prisma.account.create({ data: {
    householdId, name: 'Exclusion account', type: 'CHECKING', currency: 'BRL',
    balance: new Prisma.Decimal('100.00'), availableBalance: new Prisma.Decimal('100.00'), totalBalance: new Prisma.Decimal('100.00'),
  } });
  accountId = account.id;
  app = await createTestApp();
});

afterAll(async () => { await app.close(); await disposeBootstrapTestDb(); });

const headers = { authorization: 'Bearer exclusion-user' };

async function createSchedule(startDate: string, targetAccountId = accountId): Promise<string> {
  const response = await app.inject({ method: 'POST', url: '/v1/recurring-transactions/managed', headers, payload: {
    householdId, accountId: targetAccountId, categoryCode: 'FOOD', amount: { minorUnits: 7300, currency: 'BRL' },
    frequency: 'MONTHLY', kind: 'FIXED', recurrenceMode: 'ALWAYS', startDate, timeZone: 'America/Sao_Paulo',
  } });
  expect(response.statusCode).toBe(201);
  return response.json().id as string;
}

async function dates(id: string, from: string, to: string): Promise<string[]> {
  const response = await app.inject({ method: 'GET', url: `/v1/recurring-transactions/occurrences?householdId=${householdId}&from=${from}&to=${to}`, headers });
  expect(response.statusCode).toBe(200);
  return (response.json().items as Array<{ recurringTransactionId: string; date: string }>).filter((item) => item.recurringTransactionId === id).map((item) => item.date);
}

async function exclude(id: string, date: string, scope: string): Promise<Response> {
  return app.inject({ method: 'POST', url: `/v1/recurring-transactions/${id}/occurrences/${date}/exclude`, headers, payload: { householdId, scope } });
}

describe('managed recurring occurrence exclusion', () => {
  it('excludes only selected date, is idempotent, and leaves later dates visible', async () => {
    const id = await createSchedule('2027-01-10');
    const first = await exclude(id, '2027-02-10', 'CURRENT_ONLY');
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ recurringTransactionId: id, date: '2027-02-10', scope: 'CURRENT_ONLY', replayed: false });
    const replay = await exclude(id, '2027-02-10', 'CURRENT_ONLY');
    expect(replay.statusCode).toBe(200);
    expect(replay.json().replayed).toBe(true);
    expect(await dates(id, '2027-01-01', '2027-04-30')).toEqual(['2027-01-10', '2027-03-10', '2027-04-10']);
  });

  it('advances the scheduler past an excluded occurrence without materializing it', async () => {
    const { executeRecurringTransaction } = await import('../../src/modules/recurring-transactions/recurring-transactions.service.js');
    const id = await createSchedule('2026-01-10');
    expect((await exclude(id, '2026-01-10', 'CURRENT_ONLY')).statusCode).toBe(200);
    await expect(executeRecurringTransaction(id, householdId, { date: new Date('2026-01-10T00:00:00.000Z'), paid: false })).rejects.toMatchObject({ code: 'RECURRING_OCCURRENCE_EXCLUDED' });
    const schedule = await prisma.recurringTransaction.findUniqueOrThrow({ where: { id } });
    expect(schedule.nextRunAt.toISOString().slice(0, 10)).toBe('2026-02-10');
    expect(await prisma.recurringOccurrence.count({ where: { recurringTransactionId: id } })).toBe(0);
    await executeRecurringTransaction(id, householdId, { date: new Date('2026-02-10T00:00:00.000Z'), paid: false });
    await expect(executeRecurringTransaction(id, householdId, { date: new Date('2026-01-10T00:00:00.000Z'), paid: false })).rejects.toMatchObject({ code: 'RECURRING_OCCURRENCE_EXCLUDED' });
    expect((await prisma.recurringTransaction.findUniqueOrThrow({ where: { id } })).nextRunAt.toISOString().slice(0, 10)).toBe('2026-03-10');
  });

  it('distinguishes current and future cutoff from future-only cutoff', async () => {
    const inclusiveId = await createSchedule('2027-01-10');
    const exclusiveId = await createSchedule('2027-01-10');
    expect((await exclude(inclusiveId, '2027-02-10', 'CURRENT_AND_FUTURE')).statusCode).toBe(200);
    expect((await exclude(exclusiveId, '2027-02-10', 'FUTURE_ONLY')).statusCode).toBe(200);
    expect((await prisma.recurringTransaction.findUniqueOrThrow({ where: { id: inclusiveId } })).isActive).toBe(true);
    expect((await prisma.recurringTransaction.findUniqueOrThrow({ where: { id: exclusiveId } })).isActive).toBe(true);
    expect(await dates(inclusiveId, '2027-01-01', '2027-04-30')).toEqual(['2027-01-10']);
    expect(await dates(exclusiveId, '2027-01-01', '2027-04-30')).toEqual(['2027-01-10', '2027-02-10']);
  });

  it('counts an excluded date toward a limited recurrence and stops after its last slot', async () => {
    const { executeRecurringTransaction } = await import('../../src/modules/recurring-transactions/recurring-transactions.service.js');
    const response = await app.inject({ method: 'POST', url: '/v1/recurring-transactions/managed', headers, payload: {
      householdId, accountId, categoryCode: 'FOOD', amount: { minorUnits: 1000, currency: 'BRL' },
      frequency: 'MONTHLY', kind: 'FIXED', recurrenceMode: 'LIMITED', occurrencesLimit: 3,
      startDate: '2026-01-10', timeZone: 'America/Sao_Paulo',
    } });
    expect(response.statusCode).toBe(201);
    const id = response.json().id as string;
    await executeRecurringTransaction(id, householdId, { date: new Date('2026-01-10T00:00:00.000Z'), paid: false });
    expect((await exclude(id, '2026-01-10', 'CURRENT_ONLY')).statusCode).toBe(200);
    for (const date of ['2026-02-10', '2026-03-10']) {
      await executeRecurringTransaction(id, householdId, { date: new Date(`${date}T00:00:00.000Z`), paid: false });
    }
    expect((await prisma.recurringTransaction.findUniqueOrThrow({ where: { id } })).isActive).toBe(false);
    expect(await dates(id, '2026-01-01', '2026-04-30')).toEqual(['2026-02-10', '2026-03-10']);
  });

  it('soft deletes a materialized unpaid occurrence and prevents payment or scheduler recreation', async () => {
    const { executeRecurringTransaction } = await import('../../src/modules/recurring-transactions/recurring-transactions.service.js');
    const id = await createSchedule('2026-01-10');
    const date = '2026-01-10';
    const pending = await executeRecurringTransaction(id, householdId, { date: new Date(`${date}T00:00:00.000Z`), paid: false });
    expect(pending.transaction.paid).toBe(false);
    expect((await exclude(id, date, 'CURRENT_ONLY')).statusCode).toBe(200);
    const deleted = await prisma.transaction.findUniqueOrThrow({ where: { id: pending.transaction.id } });
    expect(deleted.deletedAt).not.toBeNull();
    expect(await dates(id, '2026-01-01', '2026-03-31')).toEqual(['2026-02-10', '2026-03-10']);
    const payment = await app.inject({ method: 'POST', url: `/v1/recurring-transactions/${id}/occurrences/${date}/pay`, headers, payload: {
      householdId, amount: { minorUnits: 7300, currency: 'BRL' }, clientMutationId: '6eb465a0-4295-43ca-8278-fec9419cb631',
    } });
    expect(payment.statusCode).toBe(409);
    expect(payment.json().error.code).toBe('RECURRING_OCCURRENCE_EXCLUDED');
    await expect(executeRecurringTransaction(id, householdId, { date: new Date(`${date}T00:00:00.000Z`), paid: false })).rejects.toMatchObject({ code: 'RECURRING_OCCURRENCE_EXCLUDED' });
    expect(await prisma.transaction.count({ where: { recurringTransactionId: id, deletedAt: null } })).toBe(0);
  });

  it('rejects excluding a paid selected date but preserves paid later history after an inclusive cutoff', async () => {
    const id = await createSchedule('2026-01-10');
    const paid = await app.inject({ method: 'POST', url: `/v1/recurring-transactions/${id}/occurrences/2026-03-10/pay`, headers, payload: {
      householdId, amount: { minorUnits: 7300, currency: 'BRL' }, clientMutationId: '40b52ce1-4656-48b5-a92a-81f2fc6b5992',
    } });
    expect(paid.statusCode).toBe(200);
    const conflict = await exclude(id, '2026-03-10', 'CURRENT_ONLY');
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error.code).toBe('RECURRING_OCCURRENCE_PAID');
    expect((await exclude(id, '2026-02-10', 'CURRENT_AND_FUTURE')).statusCode).toBe(200);
    expect(await dates(id, '2026-01-01', '2026-04-30')).toEqual(['2026-01-10', '2026-03-10']);
    expect(await prisma.transaction.findUniqueOrThrow({ where: { id: paid.json().transactionId as string } })).toMatchObject({ paid: true, deletedAt: null });
  });

  it('reverses an unpaid card occurrence from its open invoice without touching the card limit', async () => {
    const { executeRecurringTransaction } = await import('../../src/modules/recurring-transactions/recurring-transactions.service.js');
    const futureDate = `${new Date().getUTCFullYear() + 2}-01-10`;
    const card = await prisma.account.create({ data: {
      householdId, name: 'Exclusion card', type: 'CREDIT', currency: 'BRL',
      creditLimit: new Prisma.Decimal('500.00'), totalLimit: new Prisma.Decimal('500.00'), availableLimit: new Prisma.Decimal('500.00'),
      closingDay: 14, dueDay: 20,
    } });
    const id = await createSchedule(futureDate, card.id);
    const pending = await executeRecurringTransaction(id, householdId, { date: new Date(`${futureDate}T00:00:00.000Z`), paid: false });
    const pendingRow = await prisma.transaction.findUniqueOrThrow({ where: { id: pending.transaction.id } });
    const before = await prisma.creditCardInvoice.findUniqueOrThrow({ where: { id: pendingRow.invoiceId! } });
    expect(before.totalAmount.toFixed(2)).toBe('73.00');
    expect((await exclude(id, futureDate, 'CURRENT_ONLY')).statusCode).toBe(200);
    const after = await prisma.creditCardInvoice.findUniqueOrThrow({ where: { id: before.id } });
    expect(after.totalAmount.toFixed(2)).toBe('0.00');
    expect((await prisma.account.findUniqueOrThrow({ where: { id: card.id } })).availableLimit?.toFixed(2)).toBe('500.00');
  });

  it('keeps the selected pending occurrence for future-only and soft deletes later pending occurrences', async () => {
    const { executeRecurringTransaction } = await import('../../src/modules/recurring-transactions/recurring-transactions.service.js');
    const id = await createSchedule('2026-01-10');
    const current = await executeRecurringTransaction(id, householdId, { date: new Date('2026-01-10T00:00:00.000Z'), paid: false });
    const later = await executeRecurringTransaction(id, householdId, { date: new Date('2026-02-10T00:00:00.000Z'), paid: false });
    expect((await exclude(id, '2026-01-10', 'FUTURE_ONLY')).statusCode).toBe(200);
    expect((await prisma.transaction.findUniqueOrThrow({ where: { id: current.transaction.id } })).deletedAt).toBeNull();
    expect((await prisma.transaction.findUniqueOrThrow({ where: { id: later.transaction.id } })).deletedAt).not.toBeNull();
    expect(await dates(id, '2026-01-01', '2026-03-31')).toEqual(['2026-01-10']);
  });

  it('rolls back exclusion if a pending card transaction belongs to a closed invoice', async () => {
    const { executeRecurringTransaction } = await import('../../src/modules/recurring-transactions/recurring-transactions.service.js');
    const futureDate = `${new Date().getUTCFullYear() + 2}-01-10`;
    const card = await prisma.account.create({ data: {
      householdId, name: 'Closed invoice card', type: 'CREDIT', currency: 'BRL',
      creditLimit: new Prisma.Decimal('500.00'), totalLimit: new Prisma.Decimal('500.00'), availableLimit: new Prisma.Decimal('500.00'),
      closingDay: 14, dueDay: 20,
    } });
    const id = await createSchedule(futureDate, card.id);
    const pending = await executeRecurringTransaction(id, householdId, { date: new Date(`${futureDate}T00:00:00.000Z`), paid: false });
    const pendingRow = await prisma.transaction.findUniqueOrThrow({ where: { id: pending.transaction.id } });
    await prisma.creditCardInvoice.update({ where: { id: pendingRow.invoiceId! }, data: { status: 'CLOSED' } });
    const response = await exclude(id, futureDate, 'CURRENT_ONLY');
    expect(response.statusCode).toBe(400);
    expect((await prisma.transaction.findUniqueOrThrow({ where: { id: pending.transaction.id } })).deletedAt).toBeNull();
    expect(await prisma.recurringOccurrenceExclusion.count({ where: { recurringTransactionId: id } })).toBe(0);
  });

  it('rejects invalid civil dates and non-occurrence dates', async () => {
    const id = await createSchedule('2027-01-10');
    expect((await exclude(id, '2027-02-30', 'CURRENT_ONLY')).statusCode).toBe(400);
    expect((await exclude(id, '2027-02-11', 'CURRENT_ONLY')).statusCode).toBe(404);
  });

  it('does not expand an ancient cancelled daily rule across decades for a recent read', async () => {
    const jan2000 = new Date('2000-01-01T00:00:00.000Z');
    const id = (await prisma.recurringTransaction.create({ data: {
      householdId, accountId, categoryName: 'FOOD', amount: new Prisma.Decimal('1.00'),
      frequency: 'DAILY', anchorDay: 1, startDate: jan2000, effectiveFromDate: jan2000,
      nextRunAt: new Date('2000-01-02T00:00:00.000Z'), cancelledAt: jan2000, isActive: false,
    } })).id;
    expect(await dates(id, '2027-01-01', '2027-01-31')).toEqual([]);
  });
});
