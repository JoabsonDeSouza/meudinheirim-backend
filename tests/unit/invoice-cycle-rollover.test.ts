import { afterEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '../../src/generated/prisma/client.js';
import { getOrCreateInvoiceForTransaction } from '../../src/modules/credit-cards/domain/invoice-cycle.js';

afterEach(() => vi.useRealTimers());

describe('credit card invoice rollover', () => {
  it('closes the expired cycle when the next charge creates a new invoice with closing day 14', async () => {
    const invoices: Array<{ id: string; periodStart: string; periodEnd: string; dueDate: string; status: string; totalAmount: string }> = [];
    const tx = {
      creditCardInvoice: {
        findUnique: vi.fn(async ({ where }: { where: { cardAccountId_periodStart: { periodStart: Date } } }) =>
          invoices.find((invoice) => invoice.periodStart === where.cardAccountId_periodStart.periodStart.toISOString().slice(0, 10)) ?? null),
        upsert: vi.fn(async ({ create }: { create: { periodStart: Date; periodEnd: Date; dueDate: Date; status: string; totalAmount: Prisma.Decimal } }) => {
          const invoice = { id: `invoice-${invoices.length + 1}`, periodStart: create.periodStart.toISOString().slice(0, 10), periodEnd: create.periodEnd.toISOString().slice(0, 10), dueDate: create.dueDate.toISOString().slice(0, 10), status: create.status, totalAmount: create.totalAmount.toString() };
          invoices.push(invoice);
          return { id: invoice.id };
        }),
        updateMany: vi.fn(async ({ where }: { where: { periodEnd: { lte: Date } } }) => {
          const boundary = where.periodEnd.lte.toISOString().slice(0, 10);
          for (const invoice of invoices) if (invoice.status === 'OPEN' && invoice.periodEnd <= boundary) invoice.status = 'CLOSED';
          return { count: 1 };
        }),
      },
    };
    const add = async (date: string): Promise<string> => getOrCreateInvoiceForTransaction(tx as never, {
      householdId: 'synthetic-household', cardAccountId: 'synthetic-card', currency: 'BRL',
      closingDay: 14, dueDay: 5, occurredAt: new Date(date), timeZone: 'America/Sao_Paulo',
      amount: new Prisma.Decimal('73.00'), transactionType: 'EXPENSE',
    });
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-13T15:00:00Z'));
    await add('2026-10-13T15:00:00Z');
    vi.setSystemTime(new Date('2026-11-01T15:00:00Z'));
    await add('2026-11-01T15:00:00Z');

    expect(invoices).toEqual([
      { id: 'invoice-1', periodStart: '2026-09-14', periodEnd: '2026-10-14', dueDate: '2026-11-05', status: 'CLOSED', totalAmount: '73' },
      { id: 'invoice-2', periodStart: '2026-10-14', periodEnd: '2026-11-14', dueDate: '2026-12-05', status: 'OPEN', totalAmount: '73' },
    ]);
    expect(tx.creditCardInvoice.updateMany).toHaveBeenCalledTimes(2);
  });
});
