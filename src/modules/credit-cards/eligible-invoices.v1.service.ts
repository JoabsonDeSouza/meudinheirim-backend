import { Prisma } from '../../generated/prisma/client.js';
import { InvoiceStatus } from '../../generated/prisma/enums.js';
import { AccountType } from '../../shared/enums/index.js';
import { BadRequestError, NotFoundError } from '../../shared/errors/index.js';
import { decimalToMinorUnits, type Currency } from '../../shared/money/index.js';
import { prisma } from '../../shared/db/prisma.js';
import { billingCycleWindow, calculateBillingCycle, type BillingCycle } from './domain/billing-cycle.js';
import { SELECTABLE_FOLLOWING_CYCLES } from './domain/invoice-cycle.js';

/** Most recent OPEN and CLOSED unpaid invoices listed; PAID invoices are never listed as eligible. */
const ELIGIBLE_EXISTING_LIMIT = 12;

export interface EligibleInvoiceV1Dto {
  readonly invoiceId: string | null;
  readonly exists: boolean;
  readonly status: 'OPEN' | 'CLOSED' | 'PAID' | 'NOT_CREATED';
  readonly billingPeriodStart: string;
  readonly billingPeriodEnd: string;
  readonly dueDate: string;
  readonly totalAmount: { minorUnits: number; currency: Currency };
  readonly outstandingAmount: { minorUnits: number; currency: Currency };
  readonly closedAt: string | null;
}

export interface EligibleInvoicesV1Dto {
  readonly items: readonly EligibleInvoiceV1Dto[];
  /** The invoice the automatic cycle rule would use for `occurredAt` (PAID included, so the app can offer another invoice). */
  readonly automatic: EligibleInvoiceV1Dto | null;
}

type InvoiceRow = Prisma.CreditCardInvoiceGetPayload<{ include: { payments: { select: { amount: true } } } }>;

function ymd(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function supportedCurrency(value: string): Currency {
  if (value !== 'BRL' && value !== 'USD') throw new BadRequestError('Invoice currency is not supported');
  return value;
}

function invoiceDto(row: InvoiceRow, currency: Currency): EligibleInvoiceV1Dto {
  const zero = new Prisma.Decimal(0);
  const paid = row.payments.reduce((sum, payment) => sum.add(payment.amount), zero);
  const outstanding = row.totalAmount.sub(paid);
  return {
    invoiceId: row.id,
    exists: true,
    status: row.status,
    billingPeriodStart: ymd(row.periodStart),
    billingPeriodEnd: ymd(row.periodEnd),
    dueDate: ymd(row.dueDate),
    totalAmount: { minorUnits: decimalToMinorUnits(row.totalAmount, currency), currency },
    outstandingAmount: { minorUnits: decimalToMinorUnits(outstanding.greaterThan(zero) ? outstanding : zero, currency), currency },
    closedAt: row.closedAt?.toISOString() ?? null,
  };
}

function notCreatedDto(cycle: BillingCycle, currency: Currency): EligibleInvoiceV1Dto {
  return {
    invoiceId: null,
    exists: false,
    status: 'NOT_CREATED',
    billingPeriodStart: cycle.periodStart,
    billingPeriodEnd: cycle.periodEnd,
    dueDate: cycle.dueDate,
    totalAmount: { minorUnits: 0, currency },
    outstandingAmount: { minorUnits: 0, currency },
    closedAt: null,
  };
}

export async function listEligibleInvoicesV1(input: {
  householdId: string;
  cardAccountId: string;
  timeZone: string;
  occurredAt?: string;
}): Promise<EligibleInvoicesV1Dto> {
  const card = await prisma.account.findFirst({
    where: { id: input.cardAccountId, householdId: input.householdId },
    select: { type: true, currency: true, closingDay: true, dueDay: true },
  });
  if (!card) throw new NotFoundError('Card account');
  if (card.type !== AccountType.CREDIT) throw new BadRequestError('Account is not a credit card');
  const currency = supportedCurrency(card.currency);

  const window = billingCycleWindow(new Date().toISOString(), card.closingDay, card.dueDay, input.timeZone, SELECTABLE_FOLLOWING_CYCLES);
  const automaticCycle = input.occurredAt === undefined
    ? null
    : calculateBillingCycle(input.occurredAt, card.closingDay, card.dueDay, input.timeZone);
  const windowStarts = [...window.map((cycle) => cycle.periodStart), ...(automaticCycle ? [automaticCycle.periodStart] : [])];

  const [openOrClosed, windowRows] = await Promise.all([
    prisma.creditCardInvoice.findMany({
      where: { householdId: input.householdId, cardAccountId: input.cardAccountId, status: { in: [InvoiceStatus.OPEN, InvoiceStatus.CLOSED] } },
      include: { payments: { where: { refundedAt: null }, select: { amount: true } } },
      orderBy: [{ dueDate: 'desc' }, { id: 'desc' }],
    }),
    prisma.creditCardInvoice.findMany({
      where: {
        householdId: input.householdId,
        cardAccountId: input.cardAccountId,
        periodStart: { in: windowStarts.map((start) => new Date(`${start}T00:00:00.000Z`)) },
      },
      include: { payments: { where: { refundedAt: null }, select: { amount: true } } },
    }),
  ]);

  const rowByStart = new Map(windowRows.map((row) => [ymd(row.periodStart), row]));
  const recent = openOrClosed.slice(0, ELIGIBLE_EXISTING_LIMIT).map((row) => invoiceDto(row, currency));
  const listed = new Set(recent.map((item) => item.invoiceId));

  const items: EligibleInvoiceV1Dto[] = [...recent];
  for (const cycle of window) {
    const row = rowByStart.get(cycle.periodStart);
    if (row === undefined) {
      items.push(notCreatedDto(cycle, currency));
    } else if (row.status !== InvoiceStatus.PAID && !listed.has(row.id)) {
      items.push(invoiceDto(row, currency));
    }
  }
  items.sort((a, b) => b.dueDate.localeCompare(a.dueDate) || (a.invoiceId ?? '').localeCompare(b.invoiceId ?? ''));

  let automatic: EligibleInvoiceV1Dto | null = null;
  if (automaticCycle) {
    const row = rowByStart.get(automaticCycle.periodStart);
    automatic = row === undefined ? notCreatedDto(automaticCycle, currency) : invoiceDto(row, currency);
  }
  return { items, automatic };
}
