import type { Prisma } from '../../../generated/prisma/client.js';
import { InvoiceStatus } from '../../../generated/prisma/enums.js';
import { InvoicePaidError } from '../../../shared/errors/index.js';
import { calculateBillingCycle, civilDateStringAtInstant } from './billing-cycle.js';

export interface InvoiceCycleTransaction {
  readonly householdId: string;
  readonly cardAccountId: string;
  readonly currency: 'BRL' | 'USD';
  readonly closingDay: number | null;
  readonly dueDay: number | null;
  readonly occurredAt: Date;
  readonly timeZone: string;
  readonly amount: Prisma.Decimal;
  readonly transactionType: 'INCOME' | 'EXPENSE';
}

export function signedInvoiceAmount(
  amount: Prisma.Decimal,
  transactionType: 'INCOME' | 'EXPENSE',
): Prisma.Decimal {
  return transactionType === 'EXPENSE' ? amount : amount.negated();
}

export async function adjustInvoiceTotal(
  tx: Prisma.TransactionClient,
  invoiceId: string,
  delta: Prisma.Decimal,
): Promise<void> {
  await tx.creditCardInvoice.update({
    where: { id: invoiceId },
    data: { totalAmount: { increment: delta } },
  });
}

export async function getOrCreateInvoiceForTransaction(
  tx: Prisma.TransactionClient,
  input: InvoiceCycleTransaction,
): Promise<string> {
  const cycle = calculateBillingCycle(
    input.occurredAt.toISOString(),
    input.closingDay,
    input.dueDay,
    input.timeZone,
  );
  const periodStart = new Date(`${cycle.periodStart}T00:00:00.000Z`);
  const periodEnd = new Date(`${cycle.periodEnd}T00:00:00.000Z`);
  const dueDate = new Date(`${cycle.dueDate}T00:00:00.000Z`);
  const localToday = civilDateStringAtInstant(new Date().toISOString(), input.timeZone);
  const amountChange = signedInvoiceAmount(input.amount, input.transactionType);

  const existing = await tx.creditCardInvoice.findUnique({
    where: { cardAccountId_periodStart: { cardAccountId: input.cardAccountId, periodStart } },
    select: { id: true, status: true, paidAt: true },
  });
  if (existing && existing.status === InvoiceStatus.PAID) {
    throw new InvoicePaidError('A paid invoice cannot accept new transactions');
  }

  // Fecha faturas abertas de períodos anteriores já vencidos, exceto a do
  // período desta transação (que ainda está sendo usada).
  await tx.creditCardInvoice.updateMany({
    where: {
      householdId: input.householdId,
      cardAccountId: input.cardAccountId,
      status: InvoiceStatus.OPEN,
      periodEnd: { lte: new Date(`${localToday}T00:00:00.000Z`) },
      periodStart: { not: periodStart },
    },
    data: { status: InvoiceStatus.CLOSED, closedAt: new Date(), version: { increment: 1 } },
  });

  const invoice = await tx.creditCardInvoice.upsert({
    where: {
      cardAccountId_periodStart: {
        cardAccountId: input.cardAccountId,
        periodStart,
      },
    },
    create: {
      householdId: input.householdId,
      cardAccountId: input.cardAccountId,
      periodStart,
      periodEnd,
      dueDate,
      status: InvoiceStatus.OPEN,
      currency: input.currency,
      totalAmount: amountChange,
    },
    update: {
      periodEnd,
      dueDate,
      totalAmount: { increment: amountChange },
    },
    select: { id: true },
  });
  return invoice.id;
}
