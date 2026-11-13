import { Prisma } from '../../generated/prisma/client.js';
import { TransactionType } from '../../generated/prisma/enums.js';
import { BadRequestError } from '../../shared/errors/index.js';
import { decimalToMinorUnits, type Currency } from '../../shared/money/index.js';
import { prisma } from '../../shared/db/prisma.js';
import { listRecurringOccurrencesV1 } from '../recurring-transactions/recurring.v1.service.js';
import type {
  DashboardMonthForecastV1Query,
  DashboardSpendingPaceV1Query,
} from './dashboard.forecast.v1.schema.js';

const ZERO = new Prisma.Decimal(0);
const DAY_MS = 86400000;

function supportedCurrency(value: string): Currency {
  if (value !== 'BRL' && value !== 'USD') throw new BadRequestError('Dashboard currency is not supported');
  return value;
}

interface MonthBounds {
  readonly start: Date;
  readonly endExclusive: Date;
  readonly lastDay: Date;
}

export interface MonthForecastV1Response {
  readonly month: string;
  readonly asOf: string;
  readonly byCurrency: ReadonlyArray<{
    readonly currency: Currency;
    readonly availableBalance: MoneyV1;
    readonly pendingRecurring: MoneyV1;
    readonly openInvoices: MoneyV1;
    readonly variableRemaining: MoneyV1;
    readonly projectedLeftover: MoneyV1;
  }>;
}

export interface SpendingPaceV1Response {
  readonly month: string;
  readonly day: number;
  readonly previousMonth: string;
  readonly byCurrency: ReadonlyArray<{
    readonly currency: Currency;
    readonly currentToDate: MoneyV1;
    readonly previousToDate: MoneyV1;
    readonly changeRatio: number | null;
  }>;
}

export interface MoneyV1 {
  readonly minorUnits: number;
  readonly currency: Currency;
}

function parseMonth(month: string): MonthBounds {
  const start = new Date(`${month}-01T00:00:00.000Z`);
  const endExclusive = new Date(start.getTime());
  endExclusive.setUTCMonth(endExclusive.getUTCMonth() + 1);
  return { start, endExclusive, lastDay: new Date(endExclusive.getTime() - DAY_MS) };
}

function shiftMonth(month: string, delta: number): string {
  const date = new Date(`${month}-01T00:00:00.000Z`);
  date.setUTCMonth(date.getUTCMonth() + delta);
  return date.toISOString().slice(0, 7);
}

function civil(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function addToMap(map: Map<Currency, Prisma.Decimal>, currency: Currency, amount: Prisma.Decimal): void {
  map.set(currency, (map.get(currency) ?? ZERO).add(amount));
}

function money(amount: Prisma.Decimal, currency: Currency): MoneyV1 {
  return { minorUnits: decimalToMinorUnits(amount, currency), currency };
}

function sortedCurrencies(...maps: Array<Map<Currency, unknown>>): Currency[] {
  const set = new Set<Currency>();
  for (const map of maps) for (const currency of map.keys()) set.add(currency);
  return [...set].sort((left, right) => left.localeCompare(right));
}

/**
 * Projected leftover for the month, per currency.
 *
 * leftover = availableBalance (non-credit active accounts)
 *          - pendingRecurring   (fixed/variable occurrences of the month not yet paid)
 *          - openInvoices       (unpaid card invoices due up to the end of the month)
 *          - variableRemaining  (max(0, avg of last 3 full months of bank-account expenses - spent so far))
 *
 * Card purchases are NOT subtracted separately: they already sit inside the invoice total.
 * Transfers (including invoice payments) are excluded from variable spend.
 */
export async function getMonthForecastV1(
  query: DashboardMonthForecastV1Query,
  householdId: string,
): Promise<MonthForecastV1Response> {
  const { start, endExclusive, lastDay } = parseMonth(query.month);
  const requestedAsOf = new Date(`${query.asOf ?? new Date().toISOString().slice(0, 10)}T00:00:00.000Z`);
  const asOfDate = requestedAsOf < start ? start : requestedAsOf > lastDay ? lastDay : requestedAsOf;
  const asOfEndExclusive = new Date(asOfDate.getTime() + DAY_MS);
  const windowStart = parseMonth(shiftMonth(query.month, -3)).start;

  const [accounts, recurring, invoices, bankExpenses] = await Promise.all([
    prisma.account.findMany({
      where: { householdId, isActive: true, type: { not: 'CREDIT' } },
      select: { currency: true, availableBalance: true },
    }),
    listRecurringOccurrencesV1(householdId, civil(start), civil(lastDay)),
    prisma.creditCardInvoice.findMany({
      where: { householdId, dueDate: { lt: endExclusive } },
      include: { payments: { where: { refundedAt: null }, select: { amount: true } } },
    }),
    prisma.transaction.findMany({
      where: {
        householdId,
        deletedAt: null,
        type: TransactionType.EXPENSE,
        invoiceId: null,
        recurringTransactionId: null,
        date: { gte: windowStart, lt: endExclusive },
      },
      select: { amount: true, date: true, account: { select: { currency: true } } },
    }),
  ]);

  const available = new Map<Currency, Prisma.Decimal>();
  for (const account of accounts) addToMap(available, supportedCurrency(account.currency), account.availableBalance);

  const pendingRecurring = new Map<Currency, Prisma.Decimal>();
  for (const entry of recurring.totalsByCurrency) {
    const currency = supportedCurrency(String(entry.currency));
    // remainingMinorUnits is already in minor units; convert back to a decimal amount for uniform rounding.
    const remaining = new Prisma.Decimal(Number(entry.remainingMinorUnits)).div(100);
    addToMap(pendingRecurring, currency, remaining);
  }

  const openInvoices = new Map<Currency, Prisma.Decimal>();
  for (const invoice of invoices) {
    const currency = supportedCurrency(invoice.currency);
    const paid = invoice.payments.reduce((sum, payment) => sum.add(payment.amount), ZERO);
    const outstanding = invoice.totalAmount.sub(paid);
    if (outstanding.greaterThan(ZERO)) addToMap(openInvoices, currency, outstanding);
  }

  const threeMonthsTotal = new Map<Currency, Prisma.Decimal>();
  const spentSoFar = new Map<Currency, Prisma.Decimal>();
  for (const expense of bankExpenses) {
    if (!expense.account) continue;
    const currency = supportedCurrency(expense.account.currency);
    const amount = expense.amount.abs();
    if (expense.date < start) addToMap(threeMonthsTotal, currency, amount);
    if (expense.date >= start && expense.date < asOfEndExclusive) addToMap(spentSoFar, currency, amount);
  }

  const currencies = sortedCurrencies(available, pendingRecurring, openInvoices, threeMonthsTotal, spentSoFar);
  const byCurrency = currencies.map((currency) => {
    const avg = (threeMonthsTotal.get(currency) ?? ZERO).div(3);
    const remainingVariable = Prisma.Decimal.max(ZERO, avg.sub(spentSoFar.get(currency) ?? ZERO));
    const balance = available.get(currency) ?? ZERO;
    const pending = pendingRecurring.get(currency) ?? ZERO;
    const invoicesDue = openInvoices.get(currency) ?? ZERO;
    const leftover = balance.sub(pending).sub(invoicesDue).sub(remainingVariable);
    return {
      currency,
      availableBalance: money(balance, currency),
      pendingRecurring: money(pending, currency),
      openInvoices: money(invoicesDue, currency),
      variableRemaining: money(remainingVariable, currency),
      projectedLeftover: money(leftover, currency),
    };
  });

  return { month: query.month, asOf: civil(asOfDate), byCurrency };
}

/**
 * Spending pace: expense total from day 1 to `day` of the month vs the same window of the previous month.
 * Uses the same `date` field and EXPENSE-only filter as the dashboard overview.
 */
export async function getSpendingPaceV1(
  query: DashboardSpendingPaceV1Query,
  householdId: string,
): Promise<SpendingPaceV1Response> {
  const { start, lastDay } = parseMonth(query.month);
  const monthDays = lastDay.getUTCDate();
  const todayUtc = new Date().toISOString().slice(0, 10);
  const defaultDay = todayUtc.slice(0, 7) === query.month ? Number(todayUtc.slice(8, 10)) : monthDays;
  const day = Math.min(query.day ?? defaultDay, monthDays);

  const prevMonth = shiftMonth(query.month, -1);
  const prev = parseMonth(prevMonth);
  const prevDay = Math.min(day, prev.lastDay.getUTCDate());
  const currentEnd = new Date(start.getTime() + (day * DAY_MS));
  const previousEnd = new Date(prev.start.getTime() + (prevDay * DAY_MS));

  const rows = await prisma.transaction.findMany({
    where: {
      householdId,
      deletedAt: null,
      type: TransactionType.EXPENSE,
      date: { gte: prev.start, lt: new Date(Math.max(currentEnd.getTime(), previousEnd.getTime())) },
    },
    select: { amount: true, date: true, account: { select: { currency: true } } },
  });

  const current = new Map<Currency, Prisma.Decimal>();
  const previous = new Map<Currency, Prisma.Decimal>();
  for (const row of rows) {
    if (!row.account) continue;
    const currency = supportedCurrency(row.account.currency);
    const amount = row.amount.abs();
    if (row.date >= start && row.date < currentEnd) addToMap(current, currency, amount);
    if (row.date >= prev.start && row.date < previousEnd) addToMap(previous, currency, amount);
  }

  const byCurrency = sortedCurrencies(current, previous).map((currency) => {
    const cur = current.get(currency) ?? ZERO;
    const prevTotal = previous.get(currency) ?? ZERO;
    const changeRatio = prevTotal.greaterThan(ZERO)
      ? Number(cur.sub(prevTotal).div(prevTotal).toDecimalPlaces(4).toString())
      : null;
    return {
      currency,
      currentToDate: money(cur, currency),
      previousToDate: money(prevTotal, currency),
      changeRatio,
    };
  });

  return { month: query.month, day, previousMonth: prevMonth, byCurrency };
}
