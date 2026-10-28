import { Prisma } from '../../generated/prisma/client.js';
import { TransactionType } from '../../generated/prisma/enums.js';
import { BadRequestError } from '../../shared/errors/index.js';
import { decimalToMinorUnits, type Currency } from '../../shared/money/index.js';
import { prisma } from '../../shared/db/prisma.js';
import type {
  DashboardOverviewV1Query,
  DashboardOverviewV1Response,
  DashboardRecentV1Query,
  DashboardRecentV1Response,
} from './dashboard.v1.schema.js';

function supportedCurrency(value: string): Currency {
  if (value !== 'BRL' && value !== 'USD') throw new BadRequestError('Dashboard currency is not supported');
  return value;
}

function monthRange(month: string): { start: Date; endExclusive: Date } {
  const start = new Date(`${month}-01T00:00:00.000Z`);
  const endExclusive = new Date(start.getTime());
  endExclusive.setUTCMonth(endExclusive.getUTCMonth() + 1);
  return {
    start,
    endExclusive,
  };
}

export async function getDashboardOverviewV1(
  query: DashboardOverviewV1Query,
  householdId: string,
): Promise<DashboardOverviewV1Response> {
  const { start, endExclusive } = monthRange(query.month);
  const [accounts, transactions] = await Promise.all([
    prisma.account.findMany({ where: { householdId }, select: { currency: true } }),
    prisma.transaction.findMany({
      where: {
        householdId,
        deletedAt: null,
        type: { in: [TransactionType.INCOME, TransactionType.EXPENSE] },
        date: { gte: start, lt: endExclusive },
      },
      include: { account: { select: { currency: true } } },
    }),
  ]);

  const totals = new Map<Currency, { income: Prisma.Decimal; expense: Prisma.Decimal }>();
  for (const account of accounts) {
    const currency = supportedCurrency(account.currency);
    if (!totals.has(currency)) totals.set(currency, { income: new Prisma.Decimal(0), expense: new Prisma.Decimal(0) });
  }
  for (const transaction of transactions) {
    if (!transaction.account) throw new BadRequestError('Dashboard transaction is missing its account');
    const currency = supportedCurrency(transaction.account.currency);
    const total = totals.get(currency) ?? { income: new Prisma.Decimal(0), expense: new Prisma.Decimal(0) };
    if (transaction.type === TransactionType.INCOME) total.income = total.income.add(transaction.amount.abs());
    if (transaction.type === TransactionType.EXPENSE) total.expense = total.expense.add(transaction.amount.abs());
    totals.set(currency, total);
  }

  const byCurrency = [...totals.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([currency, total]) => ({
    currency,
    income: { minorUnits: decimalToMinorUnits(total.income, currency), currency },
    expense: { minorUnits: decimalToMinorUnits(total.expense, currency), currency },
    balance: { minorUnits: decimalToMinorUnits(total.income.sub(total.expense), currency), currency },
  }));
  return { month: query.month, byCurrency };
}

export async function getDashboardRecentTransactionsV1(
  _query: DashboardRecentV1Query,
  householdId: string,
): Promise<DashboardRecentV1Response> {
  const transactions = await prisma.transaction.findMany({
    where: {
      householdId,
      deletedAt: null,
      type: { in: [TransactionType.INCOME, TransactionType.EXPENSE, TransactionType.TRANSFER] },
    },
    include: {
      account: { select: { currency: true } },
      fromAccount: { select: { currency: true } },
      toAccount: { select: { currency: true } },
    },
    orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
    take: 10,
  });

  const items = transactions.map((transaction) => {
    const currencyValue = transaction.account?.currency
      ?? transaction.fromAccount?.currency
      ?? transaction.toAccount?.currency;
    if (!currencyValue) throw new BadRequestError('Dashboard transaction is missing account currency');
    const currency = supportedCurrency(currencyValue);
    if (transaction.type === TransactionType.TRANSFER
      && transaction.fromAccount
      && transaction.toAccount
      && supportedCurrency(transaction.fromAccount.currency) !== supportedCurrency(transaction.toAccount.currency)) {
      throw new BadRequestError('Transfer account currencies do not match');
    }
    const kind: 'income' | 'expense' | 'transfer' = transaction.type === TransactionType.INCOME
      ? 'income'
      : transaction.type === TransactionType.EXPENSE ? 'expense' : 'transfer';
    return {
      id: transaction.id,
      kind,
      amount: { minorUnits: decimalToMinorUnits(transaction.amount.abs(), currency), currency },
      categoryCode: transaction.categoryName,
      accountId: transaction.accountId,
      fromAccountId: transaction.fromAccountId,
      toAccountId: transaction.toAccountId,
      invoiceId: transaction.invoiceId,
      installmentId: transaction.installmentId,
      installmentNumber: transaction.installmentNumber,
      totalInstallments: transaction.totalInstallments,
      installmentTotalAmount: transaction.installmentTotalAmount === null
        ? null
        : { minorUnits: decimalToMinorUnits(transaction.installmentTotalAmount, currency), currency },
      occurredAt: transaction.occurredAt.toISOString(),
      timeZone: transaction.timeZone,
      note: transaction.notes,
      paid: transaction.paid,
      version: transaction.version,
      clientMutationId: transaction.clientMutationId,
    };
  });
  return { items };
}
