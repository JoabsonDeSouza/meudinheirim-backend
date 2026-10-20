import { Prisma } from '../../../generated/prisma/client.js';
import { TransactionType } from '../../../generated/prisma/enums.js';
import { BadRequestError } from '../../../shared/errors/index.js';
import { decimalToMinorUnits, minorUnitsToDecimal, type Currency } from '../../../shared/money/index.js';
import { prisma } from '../../../shared/db/prisma.js';
import type {
  CategoryMovementV1Query,
  CategoryMovementV1Response,
  MonthlySeriesV1Query,
  MonthlySeriesV1Response,
  SpendingPatternsV1Query,
  SpendingPatternsV1Response,
} from './insights.v1.schema.js';

type InsightTransaction = Prisma.TransactionGetPayload<{
  select: {
    type: true;
    amount: true;
    categoryName: true;
    occurredAt: true;
    account: { select: { currency: true } };
  };
}>;

interface LocalMonthParts {
  readonly year: number;
  readonly month: number;
}

interface MonthTotals {
  income: Prisma.Decimal;
  expense: Prisma.Decimal;
}

const weekdayNumbers: Readonly<Record<string, number>> = {
  Sunday: 0,
  Monday: 1,
  Tuesday: 2,
  Wednesday: 3,
  Thursday: 4,
  Friday: 5,
  Saturday: 6,
};

function supportedCurrency(value: string): Currency {
  if (value !== 'BRL' && value !== 'USD') throw new BadRequestError('Insights currency is not supported');
  return value;
}

function monthKey(year: number, month: number): string {
  return `${year.toString().padStart(4, '0')}-${month.toString().padStart(2, '0')}`;
}

function parseMonth(value: string): LocalMonthParts {
  const [year, month] = value.split('-').map(Number);
  return { year: year ?? 0, month: month ?? 0 };
}

function shiftMonth(value: string, amount: number): string {
  const { year, month } = parseMonth(value);
  const monthOffset = month - 1 + amount;
  const zeroBased = (year * 12) + monthOffset;
  const nextYear = Math.floor(zeroBased / 12);
  const nextMonth = zeroBased - (nextYear * 12) + 1;
  return monthKey(nextYear, nextMonth);
}

function localDateParts(instant: Date, timeZone: string): LocalMonthParts & { day: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(instant);
  const read = (type: Intl.DateTimeFormatPartTypes): number => {
    const value = parts.find((part) => part.type === type)?.value;
    if (value === undefined) throw new BadRequestError('Could not resolve local transaction date');
    return Number(value);
  };
  return { year: read('year'), month: read('month'), day: read('day') };
}

function localMonth(instant: Date, timeZone: string): string {
  const { year, month } = localDateParts(instant, timeZone);
  return monthKey(year, month);
}

function localWeekday(instant: Date, timeZone: string): number {
  const weekday = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'long' })
    .format(instant);
  const index = weekdayNumbers[weekday];
  if (index === undefined) throw new BadRequestError('Could not resolve local transaction weekday');
  return index;
}

function broadInstantRange(firstMonth: string, monthAfterLast: string): { gte: Date; lt: Date } {
  const start = new Date(`${firstMonth}-01T00:00:00.000Z`);
  const end = new Date(`${monthAfterLast}-01T00:00:00.000Z`);
  start.setUTCDate(start.getUTCDate() - 1);
  end.setUTCDate(end.getUTCDate() + 1);
  return { gte: start, lt: end };
}

async function findHouseholdAccounts(householdId: string): Promise<Array<{ currency: string }>> {
  return prisma.account.findMany({ where: { householdId }, select: { currency: true } });
}

async function findTransactions(
  householdId: string,
  occurredAt: { gte: Date; lt: Date },
): Promise<InsightTransaction[]> {
  return prisma.transaction.findMany({
    where: {
      householdId,
      deletedAt: null,
      type: { in: [TransactionType.INCOME, TransactionType.EXPENSE] },
      occurredAt,
    },
    select: {
      type: true,
      amount: true,
      categoryName: true,
      occurredAt: true,
      account: { select: { currency: true } },
    },
  });
}

function transactionCurrency(transaction: InsightTransaction): Currency {
  if (!transaction.account) throw new BadRequestError('Insight transaction is missing its account');
  return supportedCurrency(transaction.account.currency);
}

function emptyTotals(): MonthTotals {
  return { income: new Prisma.Decimal(0), expense: new Prisma.Decimal(0) };
}

function addTransaction(totals: MonthTotals, transaction: InsightTransaction): void {
  if (transaction.type === TransactionType.INCOME) totals.income = totals.income.add(transaction.amount.abs());
  if (transaction.type === TransactionType.EXPENSE) totals.expense = totals.expense.add(transaction.amount.abs());
}

function money(amount: Prisma.Decimal, currency: Currency): { minorUnits: number; currency: Currency } {
  return { minorUnits: decimalToMinorUnits(amount, currency), currency };
}

export async function getMonthlySeriesV1(
  query: MonthlySeriesV1Query,
  householdId: string,
): Promise<MonthlySeriesV1Response> {
  const months = Array.from({ length: 12 }, (_, index) => shiftMonth(query.throughMonth, index - 11));
  const monthAfterLast = shiftMonth(query.throughMonth, 1);
  const [accounts, transactions] = await Promise.all([
    findHouseholdAccounts(householdId),
    findTransactions(householdId, broadInstantRange(months[0]!, monthAfterLast)),
  ]);
  const series = new Map<Currency, Map<string, MonthTotals>>();
  for (const account of accounts) {
    const currency = supportedCurrency(account.currency);
    if (!series.has(currency)) series.set(currency, new Map(months.map((month) => [month, emptyTotals()])));
  }
  const monthSet = new Set(months);
  for (const transaction of transactions) {
    const month = localMonth(transaction.occurredAt, query.timeZone);
    if (!monthSet.has(month)) continue;
    const currency = transactionCurrency(transaction);
    const currencySeries = series.get(currency) ?? new Map(months.map((item) => [item, emptyTotals()]));
    const totals = currencySeries.get(month) ?? emptyTotals();
    addTransaction(totals, transaction);
    currencySeries.set(month, totals);
    series.set(currency, currencySeries);
  }

  const byCurrency = [...series.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([currency, values]) => ({
    currency,
    months: months.map((month) => {
      const totals = values.get(month) ?? emptyTotals();
      return {
        month,
        income: money(totals.income, currency),
        expense: money(totals.expense, currency),
        cashFlow: money(totals.income.sub(totals.expense), currency),
      };
    }),
  }));
  return { throughMonth: query.throughMonth, timeZone: query.timeZone, byCurrency };
}

export async function getCategoryMovementV1(
  query: CategoryMovementV1Query,
  householdId: string,
): Promise<CategoryMovementV1Response> {
  const previousMonth = shiftMonth(query.month, -1);
  const [accounts, transactions] = await Promise.all([
    findHouseholdAccounts(householdId),
    findTransactions(householdId, broadInstantRange(previousMonth, shiftMonth(query.month, 1))),
  ]);
  type Movement = { kind: 'income' | 'expense'; current: Prisma.Decimal; previous: Prisma.Decimal };
  const currencies = new Map<Currency, Map<string, Movement>>();
  for (const account of accounts) currencies.set(supportedCurrency(account.currency), new Map());
  for (const transaction of transactions) {
    const period = localMonth(transaction.occurredAt, query.timeZone);
    if (period !== query.month && period !== previousMonth) continue;
    if (!transaction.categoryName) continue;
    const currency = transactionCurrency(transaction);
    const movements = currencies.get(currency) ?? new Map<string, Movement>();
    const kind = transaction.type === TransactionType.INCOME ? 'income' : 'expense';
    const key = `${kind}:${transaction.categoryName}`;
    const movement = movements.get(key) ?? {
      kind,
      current: new Prisma.Decimal(0),
      previous: new Prisma.Decimal(0),
    };
    const amount = transaction.amount.abs();
    if (period === query.month) movement.current = movement.current.add(amount);
    else movement.previous = movement.previous.add(amount);
    movements.set(key, movement);
    currencies.set(currency, movements);
  }

  const byCurrency = [...currencies.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([currency, movements]) => ({
    currency,
    movements: [...movements.entries()].map(([key, movement]) => {
      const categoryCode = key.slice(key.indexOf(':') + 1);
      const change = movement.current.sub(movement.previous);
      return {
        categoryCode,
        kind: movement.kind,
        currentAmount: money(movement.current, currency),
        previousAmount: money(movement.previous, currency),
        change: money(change, currency),
        changeRatio: movement.previous.isZero() ? null : change.div(movement.previous).toNumber(),
      };
    }).sort((left, right) => {
      const amountOrder = right.currentAmount.minorUnits - left.currentAmount.minorUnits;
      return amountOrder || left.categoryCode.localeCompare(right.categoryCode);
    }),
  }));
  return { month: query.month, previousMonth, timeZone: query.timeZone, byCurrency };
}

function weekdayCounts(month: string): number[] {
  const start = new Date(`${month}-01T00:00:00.000Z`);
  const counts = Array<number>(7).fill(0);
  for (let day = 1; ; day += 1) {
    const date = new Date(start.getTime());
    date.setUTCDate(day);
    if (date.getUTCMonth() !== start.getUTCMonth() || date.getUTCFullYear() !== start.getUTCFullYear()) break;
    counts[date.getUTCDay()] = (counts[date.getUTCDay()] ?? 0) + 1;
  }
  return counts;
}

export async function getSpendingPatternsV1(
  query: SpendingPatternsV1Query,
  householdId: string,
): Promise<SpendingPatternsV1Response> {
  const transactions = await findTransactions(householdId, broadInstantRange(query.month, shiftMonth(query.month, 1)));
  const threshold = minorUnitsToDecimal({ minorUnits: query.smallSpendThresholdMinorUnits, currency: query.currency });
  const weekdayTotals = Array.from({ length: 7 }, () => new Prisma.Decimal(0));
  let underThresholdTotal = new Prisma.Decimal(0);
  let smallSpendCount = 0;
  for (const transaction of transactions) {
    if (transaction.type !== TransactionType.EXPENSE || localMonth(transaction.occurredAt, query.timeZone) !== query.month) continue;
    if (transactionCurrency(transaction) !== query.currency) continue;
    const amount = transaction.amount.abs();
    const weekday = localWeekday(transaction.occurredAt, query.timeZone);
    weekdayTotals[weekday] = (weekdayTotals[weekday] ?? new Prisma.Decimal(0)).add(amount);
    if (amount.lessThan(threshold)) {
      underThresholdTotal = underThresholdTotal.add(amount);
      smallSpendCount += 1;
    }
  }

  const occurrences = weekdayCounts(query.month);
  const averageSpend = weekdayTotals.map((total, index) => total.div(occurrences[index] ?? 1));
  let priciestWeekday: SpendingPatternsV1Response['priciestWeekday'] = null;
  const allZero = weekdayTotals.every((total) => total.isZero());
  if (!allZero) {
    let priciest = 0;
    let cheapest = 0;
    for (let weekday = 1; weekday < 7; weekday += 1) {
      if ((averageSpend[weekday] ?? new Prisma.Decimal(0)).greaterThan(averageSpend[priciest] ?? new Prisma.Decimal(0))) priciest = weekday;
      if ((averageSpend[weekday] ?? new Prisma.Decimal(0)).lessThan(averageSpend[cheapest] ?? new Prisma.Decimal(0))) cheapest = weekday;
    }
    const lowestAverage = averageSpend[cheapest] ?? new Prisma.Decimal(0);
    priciestWeekday = {
      weekday: priciest,
      comparedWeekday: cheapest,
      factor: lowestAverage.isZero() ? null : (averageSpend[priciest] ?? new Prisma.Decimal(0)).div(lowestAverage).toNumber(),
    };
  }

  return {
    month: query.month,
    currency: query.currency,
    timeZone: query.timeZone,
    priciestWeekday,
    smallSpends: {
      total: money(underThresholdTotal, query.currency),
      count: smallSpendCount,
      threshold: money(threshold, query.currency),
    },
  };
}
