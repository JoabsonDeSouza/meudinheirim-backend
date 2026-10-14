import { decimalToMinorUnits, type Currency, type MoneyDto } from '../../shared/money/index.js';
import { BadRequestError } from '../../shared/errors/index.js';
import { prisma } from '../../shared/db/prisma.js';

export interface CreditCardInvoiceV1Dto {
  readonly id: string;
  readonly householdId: string;
  readonly cardAccountId: string;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly dueDate: string;
  readonly status: 'OPEN' | 'CLOSED' | 'PAID';
  readonly totalAmount: MoneyDto;
  readonly closedAt: string | null;
  readonly paidAt: string | null;
}

export async function listCreditCardInvoicesV1(
  householdId: string,
  cardAccountId?: string,
): Promise<CreditCardInvoiceV1Dto[]> {
  const invoices = await prisma.creditCardInvoice.findMany({
    where: {
      householdId,
      ...(cardAccountId === undefined ? {} : { cardAccountId }),
    },
    orderBy: [{ periodEnd: 'desc' }, { id: 'desc' }],
  });
  return invoices.map((invoice) => {
    if (invoice.currency !== 'BRL' && invoice.currency !== 'USD') {
      throw new BadRequestError('Invoice currency is not supported');
    }
    const currency: Currency = invoice.currency;
    return {
      id: invoice.id,
      householdId: invoice.householdId,
      cardAccountId: invoice.cardAccountId,
      periodStart: invoice.periodStart.toISOString().slice(0, 10),
      periodEnd: invoice.periodEnd.toISOString().slice(0, 10),
      dueDate: invoice.dueDate.toISOString().slice(0, 10),
      status: invoice.status,
      totalAmount: { minorUnits: decimalToMinorUnits(invoice.totalAmount, currency), currency },
      closedAt: invoice.closedAt?.toISOString() ?? null,
      paidAt: invoice.paidAt?.toISOString() ?? null,
    };
  });
}
