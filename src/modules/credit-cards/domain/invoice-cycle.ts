import type { Prisma } from '../../../generated/prisma/client.js';
import { InvoiceStatus } from '../../../generated/prisma/enums.js';
import { BadRequestError, InvoicePaidError, NotFoundError } from '../../../shared/errors/index.js';
import { billingCycleWindow, calculateBillingCycle, civilDateStringAtInstant } from './billing-cycle.js';

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

/** Future cycles (after the current one) that a manual selection may create. */
export const SELECTABLE_FOLLOWING_CYCLES = 3;

/** Manual invoice choice: an existing invoice id, or the start of a not-yet-created cycle. */
export type InvoiceSelection = { readonly invoiceId: string } | { readonly billingPeriodStart: string };

/** Serializes the invoice the charge will use before the card account row is locked (invoice → account order). */
export async function lockInvoiceForSelection(
  tx: Prisma.TransactionClient,
  input: {
    readonly cardAccountId: string;
    readonly closingDay: number | null;
    readonly dueDay: number | null;
    readonly occurredAt: Date;
    readonly timeZone: string;
    readonly selection: InvoiceSelection | null;
  },
): Promise<string | null> {
  if (input.selection !== null && 'billingPeriodStart' in input.selection) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`invoice-period:${input.cardAccountId}:${input.selection.billingPeriodStart}`}))`;
  }
  const invoiceId = input.selection !== null && 'invoiceId' in input.selection
    ? input.selection.invoiceId
    : await findAutomaticInvoiceId(tx, input);
  if (invoiceId === null) return null;
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`invoice-lifecycle:${invoiceId}`}))`;
  return invoiceId;
}

async function findAutomaticInvoiceId(
  tx: Prisma.TransactionClient,
  input: { readonly cardAccountId: string; readonly closingDay: number | null; readonly dueDay: number | null; readonly occurredAt: Date; readonly timeZone: string },
): Promise<string | null> {
  const cycle = calculateBillingCycle(input.occurredAt.toISOString(), input.closingDay, input.dueDay, input.timeZone);
  const found = await tx.creditCardInvoice.findUnique({
    where: { cardAccountId_periodStart: { cardAccountId: input.cardAccountId, periodStart: new Date(`${cycle.periodStart}T00:00:00.000Z`) } },
    select: { id: true },
  });
  return found?.id ?? null;
}

/**
 * Resolves the invoice for a card charge. `selection` null keeps the automatic cycle rule.
 * An explicit invoiceId prevails over the date; PAID blocks; OPEN and CLOSED unpaid accept.
 * A billingPeriodStart creates that not-yet-created cycle, limited to the current cycle and the next three.
 */
export async function resolveInvoiceForCharge(
  tx: Prisma.TransactionClient,
  input: InvoiceCycleTransaction & { readonly householdId: string },
  selection: InvoiceSelection | null,
): Promise<string> {
  if (selection === null) return getOrCreateInvoiceForTransaction(tx, input);
  const amountChange = signedInvoiceAmount(input.amount, input.transactionType);

  if ('invoiceId' in selection) {
    const invoice = await tx.creditCardInvoice.findFirst({
      where: { id: selection.invoiceId, householdId: input.householdId, cardAccountId: input.cardAccountId },
      select: { id: true, status: true, currency: true },
    });
    if (!invoice) throw new NotFoundError('Invoice');
    if (invoice.status === InvoiceStatus.PAID) throw new InvoicePaidError('A paid invoice cannot accept new transactions');
    if (invoice.currency !== input.currency) throw new BadRequestError('Transaction currency must match the invoice currency');
    await adjustInvoiceTotal(tx, invoice.id, amountChange);
    return invoice.id;
  }

  const window = billingCycleWindow(new Date().toISOString(), input.closingDay, input.dueDay, input.timeZone, SELECTABLE_FOLLOWING_CYCLES);
  const cycle = window.find((item) => item.periodStart === selection.billingPeriodStart);
  if (!cycle) {
    throw new BadRequestError('billingPeriodStart must be the start of the current or one of the next 3 billing cycles');
  }
  const periodStart = new Date(`${cycle.periodStart}T00:00:00.000Z`);
  const existing = await tx.creditCardInvoice.findUnique({
    where: { cardAccountId_periodStart: { cardAccountId: input.cardAccountId, periodStart } },
    select: { id: true, status: true },
  });
  if (existing?.status === InvoiceStatus.PAID) throw new InvoicePaidError('A paid invoice cannot accept new transactions');
  if (existing) throw new BadRequestError('An invoice already exists for this billing period; select it by invoiceId');
  const created = await tx.creditCardInvoice.create({
    data: {
      householdId: input.householdId,
      cardAccountId: input.cardAccountId,
      periodStart,
      periodEnd: new Date(`${cycle.periodEnd}T00:00:00.000Z`),
      dueDate: new Date(`${cycle.dueDate}T00:00:00.000Z`),
      status: InvoiceStatus.OPEN,
      currency: input.currency,
      totalAmount: amountChange,
    },
    select: { id: true },
  });
  return created.id;
}

